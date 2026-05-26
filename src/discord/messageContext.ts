/**
 * Converts recent Discord history to OpenAI messages and preserves attachment
 * URLs for tools without making old research memory globally sticky.
 */
import { Message } from 'discord.js';
import type { ChatCompletionMessageParam } from 'openai/resources/index.js';
import type { ImageCandidate, WritableTextChannel } from './types.js';
import { getRecentResearchMemory } from './researchMemory.js';

type AttachmentWithDescription = {
  description?: string | null;
};

function pushImageCandidate(candidates: ImageCandidate[], candidate: ImageCandidate) {
  if (!candidate.url) return;
  const exists = candidates.some(existing => existing.url === candidate.url && existing.proxyUrl === candidate.proxyUrl);
  if (!exists) candidates.push(candidate);
}

function appendAttachmentMarkers(message: Message, content: string, imageCandidates: ImageCandidate[]) {
  let nextContent = content;

  message.attachments.forEach(att => {
    const contentType = att.contentType || 'tipo desconhecido';
    const name = att.name || 'sem nome';
    const description = (att as AttachmentWithDescription).description?.trim();

    if (att.contentType?.startsWith('image/')) {
      pushImageCandidate(imageCandidates, { url: att.url, proxyUrl: att.proxyURL });
      nextContent += ` [imagem anexada: ${att.url}]`;
      if (att.proxyURL) nextContent += ` [imagem proxy: ${att.proxyURL}]`;
      if (description) nextContent += ` [descrição da imagem: ${description}]`;
      return;
    }

    if (att.contentType?.startsWith('audio/')) {
      nextContent += ` [audio anexado: ${name} | ${contentType} | ${att.url}]`;
      if (description) nextContent += ` [descrição/transcrição do audio: ${description}]`;
      return;
    }

    nextContent += ` [anexo: ${name} | ${contentType} | ${att.url}]`;
    if (description) nextContent += ` [descrição do anexo: ${description}]`;
  });

  return nextContent;
}

function formatBatchMessage(message: Message, content: string) {
  const displayName = message.member?.displayName || message.author.username;
  const lines = [
    `Mensagem de ${displayName} (${message.author.tag}, id ${message.author.id})`,
    `messageId: ${message.id}`,
    `createdAt: ${message.createdAt.toISOString()}`,
    `content: ${content.trim() || '(sem texto)'}`,
  ];

  return lines.join('\n');
}

function buildCurrentUserContent(messages: Message[], imageCandidates: ImageCandidate[]) {
  if (messages.length === 1) {
    return appendAttachmentMarkers(messages[0], messages[0].content, imageCandidates);
  }

  return [
    'Mensagens recebidas no mesmo chat durante uma janela de 15 segundos. Trate todas como parte do pedido atual.',
    'Preserve a autoria indicada em cada mensagem. Se uma ação depender de um usuário específico e houver ambiguidade, peça esclarecimento antes de agir.',
    'Para lembretes em lotes com vários autores, chame schedule_reminder com targetUserId e sourceMessageId do autor que pediu o lembrete.',
    '',
    ...messages.map((message) => formatBatchMessage(
      message,
      appendAttachmentMarkers(message, message.content, imageCandidates),
    )),
  ].join('\n\n');
}

// Keeps the model aware of recent Discord context while preserving image URLs for tools that need raw media.
export async function buildConversationContext(message: Message, channel: WritableTextChannel, currentMessages: Message[] = [message]) {
  const messageHistory = await channel.messages.fetch({ limit: 60 });
  const imageCandidates: ImageCandidate[] = [];
  const currentMessageIds = new Set(currentMessages.map(msg => msg.id));
  const recentMessageIds = new Set(messageHistory.map(msg => msg.id));
  for (const currentMessage of currentMessages) {
    recentMessageIds.add(currentMessage.id);
  }
  const researchMemory = await getRecentResearchMemory(channel.id, recentMessageIds);
  const conversation: ChatCompletionMessageParam[] = messageHistory
    .reverse()
    .filter(msg => !currentMessageIds.has(msg.id))
    .map(msg => {
      const content = appendAttachmentMarkers(msg, msg.content, imageCandidates);
      return {
        role: msg.author.id === message.client.user.id ? 'assistant' : 'user',
        content,
      };
    });

  if (researchMemory) {
    conversation.unshift({
      role: 'system',
      content: researchMemory,
    });
  }

  conversation.push({
    role: 'user',
    content: buildCurrentUserContent(currentMessages, imageCandidates),
  });

  return { conversation, imageCandidates };
}
