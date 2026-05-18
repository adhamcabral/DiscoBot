import { Message } from 'discord.js';
import type { ChatCompletionMessageParam } from 'openai/resources/index.js';
import { getNextAction } from '../ai/openaiClient.js';
import { getBlockedUsers } from '../utils/database.js';
import { logger, logInteraction } from '../utils/logger.js';
import { getSafeWritableChannel } from './channelUtils.js';
import { buildConversationContext } from './messageContext.js';
import { replyLongMessage, sendLongMessage } from './messageSender.js';
import { handleDirectMediaToolResult } from './mediaToolHandler.js';
import { executeToolCall, isDirectMediaTool } from './toolExecutor.js';

const MAX_TOOL_LOOPS = 10;
const AI_TIMEOUT_MS = 900000;

export async function handleMessage(message: Message) {
  let typingInterval: NodeJS.Timeout | null = null;

  try {
    const channel = await getSafeWritableChannel(message.channel);
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

    for (let i = 0; i < MAX_TOOL_LOOPS; i++) {
      const currentUser = { id: message.author.id, name: message.author.username };
      const nextAction = await getNextAction(messagesForApi, currentUser, AI_TIMEOUT_MS);
      messagesForApi.push(nextAction);

      if (!nextAction.tool_calls) {
        if (nextAction.content && !imageSent) {
          await replyLongMessage(message, channel, nextAction.content);
          await logInteraction(message, nextAction.content, toolsUsed, toolDetails);
        }
        break;
      }

      const hasMediaToolCall = nextAction.tool_calls.some(toolCall => (
        toolCall.type === 'function' && isDirectMediaTool(toolCall.function.name)
      ));

      if (nextAction.content && !imageSent && !hasMediaToolCall) {
        await sendLongMessage(channel, nextAction.content);
      }

      for (const toolCall of nextAction.tool_calls) {
        if (toolCall.type !== 'function') continue;

        const functionName = toolCall.function.name;
        toolsUsed.push(functionName);

        const functionArgs = JSON.parse(toolCall.function.arguments);
        const toolResult = await executeToolCall(functionName, functionArgs, imageCandidates, {
          channel,
          triggerMessage: message,
        });
        if (toolResult.ok) toolDetails.push(toolResult.summary);

        let functionResponseContent = toolResult.result;
        const mediaResult = await handleDirectMediaToolResult({
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
  }
}
