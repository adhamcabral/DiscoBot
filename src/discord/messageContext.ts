/**
 * Converts recent Discord history to OpenAI messages and preserves attachment
 * URLs for tools without making old research memory globally sticky.
 */
import { Message } from 'discord.js';
import type { ChatCompletionMessageParam } from 'openai/resources/index.js';
import type { ImageCandidate, WritableTextChannel } from './types.js';
import { getRecentResearchMemory } from './researchMemory.js';

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

// Keeps the model aware of recent Discord context while preserving image URLs for tools that need raw media.
export async function buildConversationContext(message: Message, channel: WritableTextChannel) {
  const messageHistory = await channel.messages.fetch({ limit: 60 });
  const imageCandidates: ImageCandidate[] = [];
  const recentMessageIds = new Set(messageHistory.map(msg => msg.id));
  recentMessageIds.add(message.id);
  const researchMemory = await getRecentResearchMemory(channel.id, recentMessageIds);
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

  if (researchMemory) {
    conversation.unshift({
      role: 'system',
      content: researchMemory,
    });
  }

  conversation.push({
    role: 'user',
    content: appendImageAttachmentMarkers(message, message.content, imageCandidates),
  });

  return { conversation, imageCandidates };
}
