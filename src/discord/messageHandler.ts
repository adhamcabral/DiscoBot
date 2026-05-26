/**
 * Coordinates one Discord request through context collection, model/tool loops,
 * media delivery, progress messages, logging, and the final response.
 */
import { Message } from 'discord.js';
import type { ChatCompletionMessageParam } from 'openai/resources/index.js';
import { getNextAction } from '../openaiClient.js';
import { getBlockedUsers } from '../database.js';
import { logger, logInteraction } from '../logger.js';
import { resolveWritableChannel } from './channelUtils.js';
import { buildConversationContext } from './messageContext.js';
import { replyLongMessage, sendLongMessage } from './messageSender.js';
import { sendMediaToolResult } from './mediaToolHandler.js';
import { recordResearchMemory } from './researchMemory.js';
import { executeTool, sendsMediaDirectly } from './toolExecutor.js';
import { startToolProgress } from './toolProgress.js';

const MAX_TOOL_LOOPS = 10;
const AI_TIMEOUT_MS = 900000;

type ParsedToolArgs =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

function parseToolArgs(functionName: string, rawArguments: string): ParsedToolArgs {
  try {
    const parsed = JSON.parse(rawArguments || '{}');

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        ok: false,
        error: `[ARGUMENTOS INVÁLIDOS] A ferramenta ${functionName} precisa receber um objeto JSON como arguments. Recebido: ${rawArguments || '(vazio)'}`,
      };
    }

    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `[ARGUMENTOS INVÁLIDOS] Não foi possível ler os arguments da ferramenta ${functionName} como JSON válido: "${message}". Refaça a chamada usando um objeto JSON válido e compatível com o schema da ferramenta.`,
    };
  }
}

// Orchestrates one Discord interaction: context -> model turn -> tool calls -> final Discord response.
export async function handleMessage(message: Message) {
  let typingInterval: NodeJS.Timeout | null = null;
  const progressHandles: Array<{ dismiss: () => Promise<void> }> = [];

  try {
    const channel = await resolveWritableChannel(message.channel);
    if (!channel) return;

    const blockedUsers = await getBlockedUsers();
    if (blockedUsers.includes(message.author.id)) return;

    typingInterval = setInterval(() => channel.sendTyping(), 9000);
    await channel.sendTyping();

    const { conversation, imageCandidates } = await buildConversationContext(message, channel);
    const messagesForApi: ChatCompletionMessageParam[] = [...conversation];
    const toolsUsed: string[] = [];
    const toolDetails: string[] = [];
    let imageSent = false;

    // The model may need several tool/result rounds; the loop cap prevents runaway tool recursion.
    for (let i = 0; i < MAX_TOOL_LOOPS; i++) {
      const currentUser = { id: message.author.id, name: message.author.username };
      const nextAction = await getNextAction(messagesForApi, currentUser, AI_TIMEOUT_MS);
      messagesForApi.push(nextAction);

      if (!nextAction.tool_calls) {
        if (nextAction.content && !imageSent) {
          await Promise.all(progressHandles.map(progress => progress.dismiss()));
          await replyLongMessage(message, channel, nextAction.content);
          await logInteraction(message, nextAction.content, toolsUsed, toolDetails);
        }
        break;
      }

      const hasMediaToolCall = nextAction.tool_calls.some(toolCall => (
        toolCall.type === 'function' && sendsMediaDirectly(toolCall.function.name)
      ));

      if (nextAction.content && !imageSent && !hasMediaToolCall) {
        await sendLongMessage(channel, nextAction.content);
      }

      for (const toolCall of nextAction.tool_calls) {
        if (toolCall.type !== 'function') continue;

        const functionName = toolCall.function.name;
        toolsUsed.push(functionName);

        const parsedArgs = parseToolArgs(functionName, toolCall.function.arguments);
        if (!parsedArgs.ok) {
          toolDetails.push(`${functionName}: argumentos inválidos`);
          messagesForApi.push({
            tool_call_id: toolCall.id,
            role: 'tool',
            content: parsedArgs.error,
          });
          continue;
        }

        const functionArgs = parsedArgs.value;
        const progress = await startToolProgress(channel, functionName, functionArgs);
        if (progress) progressHandles.push(progress);
        const toolResult = await executeTool(functionName, functionArgs, imageCandidates, {
          channel,
          triggerMessage: message,
        });
        await progress?.complete(toolResult.ok, toolResult.result);
        if (toolResult.ok) toolDetails.push(toolResult.summary);
        if (toolResult.ok) {
          recordResearchMemory({
            channelId: channel.id,
            sourceMessageId: message.id,
            toolName: functionName,
            resultText: toolResult.result,
          });
        }

        let functionResponseContent = toolResult.result;
        const mediaResult = await sendMediaToolResult({
          functionName,
          mcpResult: toolResult.result,
          channel,
          message,
          toolDetails,
        });

        if (mediaResult) {
          imageSent = imageSent || mediaResult.imageSent;
          functionResponseContent = mediaResult.toolResponse;
        }

        messagesForApi.push({
          tool_call_id: toolCall.id,
          role: 'tool',
          content: functionResponseContent,
        });
      }
    }
  } catch (error) {
    logger.error('Erro ao lidar com a mensagem:', error);
    if (message.channel?.isTextBased()) {
      await message.reply('Ocorreu um erro ao tentar responder.').catch(() => {});
    }
  } finally {
    if (typingInterval) clearInterval(typingInterval);
    await Promise.all(progressHandles.map(progress => progress.dismiss()));
  }
}
