import type { Collection, Message } from 'discord.js';
import type { WritableTextChannel } from './types.js';

type ReadDiscordContextArgs = {
  limit?: unknown;
  beforeMessageId?: unknown;
  query?: unknown;
  authorId?: unknown;
  includeBotMessages?: unknown;
};

function jsonText(value: unknown) {
  return JSON.stringify(value);
}

function getSafeLimit(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 80;
  return Math.max(1, Math.min(200, Math.floor(value)));
}

function getOptionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalize(value: string) {
  return value.toLocaleLowerCase('pt-BR');
}

function messageMatches(message: Message, args: {
  query?: string;
  authorId?: string;
  includeBotMessages: boolean;
}) {
  if (!args.includeBotMessages && message.author.bot) return false;
  if (args.authorId && message.author.id !== args.authorId) return false;

  if (!args.query) return true;

  const query = normalize(args.query);
  const content = normalize(message.content || '');
  const attachmentText = normalize(message.attachments.map((attachment) => (
    `${attachment.name || ''} ${attachment.contentType || ''} ${attachment.url || ''}`
  )).join(' '));

  return content.includes(query) || attachmentText.includes(query);
}

function serializeMessage(message: Message) {
  return {
    id: message.id,
    createdAt: message.createdAt.toISOString(),
    author: {
      id: message.author.id,
      username: message.author.username,
      tag: message.author.tag,
      bot: message.author.bot,
    },
    content: message.content || '',
    attachments: message.attachments.map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      contentType: attachment.contentType,
      size: attachment.size,
      url: attachment.url,
    })),
    referenceMessageId: message.reference?.messageId,
  };
}

function appendBatch(target: Message[], batch: Collection<string, Message>, args: {
  query?: string;
  authorId?: string;
  includeBotMessages: boolean;
}) {
  for (const message of batch.values()) {
    if (messageMatches(message, args) && !target.some((existing) => existing.id === message.id)) {
      target.push(message);
    }
  }
}

export async function readDiscordContext(
  channel: WritableTextChannel,
  triggerMessage: Message,
  rawArgs: ReadDiscordContextArgs,
) {
  const messagesApi = 'messages' in channel ? channel.messages : undefined;
  if (!messagesApi) {
    return jsonText({
      success: false,
      error: 'Este tipo de canal não permite buscar histórico de mensagens.',
    });
  }

  const limit = getSafeLimit(rawArgs.limit);
  const query = getOptionalString(rawArgs.query);
  const authorId = getOptionalString(rawArgs.authorId);
  const includeBotMessages = rawArgs.includeBotMessages !== false;
  const startBefore = getOptionalString(rawArgs.beforeMessageId) || triggerMessage.id;
  const matchedMessages: Message[] = [];
  let scannedCount = 0;
  let before = startBefore;

  while (scannedCount < limit) {
    const batchLimit = Math.min(100, limit - scannedCount);
    const batch = await messagesApi.fetch({ limit: batchLimit, before });
    if (batch.size === 0) break;

    scannedCount += batch.size;
    appendBatch(matchedMessages, batch, { query, authorId, includeBotMessages });

    const oldest = batch.last();
    if (!oldest || oldest.id === before) break;
    before = oldest.id;
  }

  const messages = matchedMessages
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .map(serializeMessage);

  return jsonText({
    success: true,
    channelId: channel.id,
    guildId: triggerMessage.guild?.id || null,
    scannedCount,
    returnedCount: messages.length,
    query: query || null,
    authorId: authorId || null,
    beforeMessageId: startBefore,
    messages,
    instruction: 'Use estas mensagens como contexto adicional do Discord. Responda em português e cite autores/datas quando isso ajudar. Se returnedCount for 0, diga que não encontrou mensagens correspondentes no intervalo buscado.',
  });
}
