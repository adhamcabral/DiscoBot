import type { Message } from 'discord.js';
import { logger } from '../logger.js';
import { enqueueChannelTask } from './channelQueue.js';
import { handleMessageBatch } from './messageHandler.js';

const DEFAULT_BATCH_DELAY_MS = 15000;
const batchDelayMs = (() => {
  const configured = Number(process.env.DISCORD_BATCH_DELAY_MS || DEFAULT_BATCH_DELAY_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_BATCH_DELAY_MS;
})();

type PendingBatch = {
  messages: Message[];
  timer: NodeJS.Timeout;
};

const pendingBatches = new Map<string, PendingBatch>();

function getChannelId(message: Message) {
  return message.channel.id;
}

function sortMessages(messages: Message[]) {
  return [...messages].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

function flushBatch(channelId: string) {
  const pending = pendingBatches.get(channelId);
  if (!pending) return;

  pendingBatches.delete(channelId);
  const messages = sortMessages(pending.messages);

  // Queue after batching so each chat keeps response order.
  void enqueueChannelTask(channelId, async () => {
    await handleMessageBatch(messages);
  }).catch((error) => {
    logger.error(`Erro na fila do canal ${channelId}:`, error);
  });
}

export function queueIncomingMessage(message: Message) {
  const channelId = getChannelId(message);
  const existing = pendingBatches.get(channelId);

  if (existing) {
    existing.messages.push(message);
    // Reset the timer so short message bursts become one model turn.
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => flushBatch(channelId), batchDelayMs);
    return;
  }

  pendingBatches.set(channelId, {
    messages: [message],
    timer: setTimeout(() => flushBatch(channelId), batchDelayMs),
  });
}
