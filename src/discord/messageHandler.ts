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

const MAX_TOOL_LOOPS = 15;
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

function getOrderedMessages(messages: Message[]) {
  return [...messages].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

export async function handleMessage(message: Message) {
  await handleMessageBatch([message]);
}

// Orchestrates one Discord interaction batch: context -> model turn -> tool calls -> final Discord response.
export async function handleMessageBatch(messages: Message[]) {
  let typingInterval: NodeJS.Timeout | null = null;
  const progressHandles: Array<{ dismiss: () => Promise<void> }> = [];
  let message = getOrderedMessages(messages).at(-1);

  try {
    if (!message) return;

    const channel = await resolveWritableChannel(message.channel);
    if (!channel) return;

    const blockedUsers = await getBlockedUsers();
    const activeMessages = getOrderedMessages(messages).filter(item => !blockedUsers.includes(item.author.id));
    if (activeMessages.length === 0) return;

    message = activeMessages[activeMessages.length - 1];

    typingInterval = setInterval(() => channel.sendTyping(), 9000);
    await channel.sendTyping();

    const { conversation, imageCandidates } = await buildConversationContext(message, channel, activeMessages);
    const messagesForApi: ChatCompletionMessageParam[] = [...conversation];
    const toolsUsed: string[] = [];
    const toolDetails: string[] = [];
    if (activeMessages.length > 1) {
      const authors = [...new Set(activeMessages.map(item => `${item.author.username}:${item.author.id}`))].join(', ');
      toolDetails.push(`message_batch: ${activeMessages.length} mensagens; authors=${authors}`);
    }
    let imageSent = false;
    let responded = false;
    let exhaustedToolLoops = false;

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
          responded = true;
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
          batchMessages: activeMessages,
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

      exhaustedToolLoops = i === MAX_TOOL_LOOPS - 1;
    }

    if (exhaustedToolLoops && !responded && !imageSent) {
      const currentUser = { id: message.author.id, name: message.author.username };
      const fallbackMessage: ChatCompletionMessageParam = {
        role: 'system',
        content: [
          `O limite interno de ${MAX_TOOL_LOOPS} rodadas de ferramentas foi atingido sem resposta final ao usuário.`,
          'Responda agora em português ao usuário, sem chamar mais ferramentas.',
          'Explique de forma natural que você não conseguiu concluir a ação com as informações/etapas disponíveis.',
          'Não exponha logs, stack traces, mensagens internas, JSON bruto ou nomes técnicos desnecessários.',
          'Se houver uma alternativa útil, peça uma reformulação ou uma parte mais específica do pedido.',
        ].join('\n'),
      };

      const finalAction = await getNextAction([...messagesForApi, fallbackMessage], currentUser, AI_TIMEOUT_MS);
      const finalContent = finalAction.content
        || 'Não consegui concluir a ação depois de várias etapas. Tente reformular o pedido ou pedir uma parte mais específica.';

      await Promise.all(progressHandles.map(progress => progress.dismiss()));
      await replyLongMessage(message, channel, finalContent);
      await logInteraction(message, finalContent, toolsUsed, [
        ...toolDetails,
        `tool_loop_limit: limite de ${MAX_TOOL_LOOPS} rodadas atingido`,
      ]);
    }
  } catch (error) {
    logger.error('Erro ao lidar com a mensagem:', error);
    if (message?.channel?.isTextBased()) {
      await message.reply('Ocorreu um erro ao tentar responder.').catch(() => {});
    }
  } finally {
    if (typingInterval) clearInterval(typingInterval);
    await Promise.all(progressHandles.map(progress => progress.dismiss()));
  }
}
