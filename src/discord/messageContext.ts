import { Message } from 'discord.js';
import type { ChatCompletionMessageParam } from 'openai/resources/index.js';
import type { ImageCandidate, WritableTextChannel } from './types.js';

function pushImageCandidate(candidates: ImageCandidate[], candidate: ImageCandidate) {
  if (!candidate.url) return;
  const exists = candidates.some(existing => existing.url === candidate.url && existing.proxyUrl === candidate.proxyUrl);
  if (!exists) candidates.push(candidate);
}

function appendImageAttachmentMarkers(message: Message, content: string, imageCandidates: ImageCandidate[]) {
  let nextContent = content;
  const imageAttachments = message.attachments.filter(att => att.contentType?.startsWith('image/'));

  imageAttachments.forEach(att => {
    pushImageCandidate(imageCandidates, { url: att.url, proxyUrl: att.proxyURL });
    nextContent += ` [imagem anexada: ${att.url}]`;
    if (att.proxyURL) nextContent += ` [imagem proxy: ${att.proxyURL}]`;
  });

  return nextContent;
}

export async function buildConversationContext(message: Message, channel: WritableTextChannel) {
  const messageHistory = await channel.messages.fetch({ limit: 20 });
  const imageCandidates: ImageCandidate[] = [];
  const conversation: ChatCompletionMessageParam[] = messageHistory
    .reverse()
    .filter(msg => msg.id !== message.id)
    .map(msg => {
      const content = appendImageAttachmentMarkers(msg, msg.content, imageCandidates);
      return {
        role: msg.author.id === message.client.user.id ? 'assistant' : 'user',
        content,
      };
    });

  conversation.push({
    role: 'user',
    content: appendImageAttachmentMarkers(message, message.content, imageCandidates),
  });

  return { conversation, imageCandidates };
}
