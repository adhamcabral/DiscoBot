import { AttachmentBuilder, Message } from 'discord.js';
import type { WritableTextChannel } from './types.js';

const DISCORD_CONTENT_LIMIT = 2000;

export function truncateDiscordContent(content?: string) {
  if (!content) return undefined;
  if (content.length <= DISCORD_CONTENT_LIMIT) return content;
  return `${content.slice(0, DISCORD_CONTENT_LIMIT - 3)}...`;
}

function splitDiscordContent(content: string) {
  const chunks: string[] = [];
  let remaining = content.trim();

  while (remaining.length > DISCORD_CONTENT_LIMIT) {
    const window = remaining.slice(0, DISCORD_CONTENT_LIMIT);
    const splitAt = Math.max(
      window.lastIndexOf('\n\n'),
      window.lastIndexOf('\n'),
      window.lastIndexOf(' '),
    );
    const cutAt = splitAt > DISCORD_CONTENT_LIMIT * 0.5 ? splitAt : DISCORD_CONTENT_LIMIT;
    const chunk = remaining.slice(0, cutAt).trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(cutAt).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

export async function sendLongMessage(channel: WritableTextChannel, content: string) {
  for (const chunk of splitDiscordContent(content)) {
    await channel.send(chunk);
  }
}

export async function replyLongMessage(message: Message, channel: WritableTextChannel, content: string) {
  const chunks = splitDiscordContent(content);
  const [first, ...rest] = chunks;

  if (first) {
    await message.reply(first);
  }

  for (const chunk of rest) {
    await channel.send(chunk);
  }
}

export function renderImageProgress(completed: number, total: number) {
  const safeTotal = Math.max(1, total || 4);
  const safeCompleted = Math.max(0, Math.min(safeTotal, completed || 0));
  const percent = Math.round((safeCompleted / safeTotal) * 100);
  const barSize = 20;
  const filled = Math.round((percent / 100) * barSize);
  const bar = `${'█'.repeat(filled)}${'░'.repeat(barSize - filled)}`;
  return `Gerando imagem...\n${bar} ${percent}%`;
}

export async function sendBase64Image(channel: WritableTextChannel, imageBase64: string, options: {
  fileName: string;
  caption?: string;
}) {
  const imageBuffer = Buffer.from(imageBase64, 'base64');
  const attachment = new AttachmentBuilder(imageBuffer, { name: options.fileName });
  await channel.send({
    content: truncateDiscordContent(options.caption),
    files: [attachment],
  });
}

export async function editImagePreview(target: Message, content: string, imageBase64?: string, fileName = 'preview.png') {
  if (!imageBase64) {
    await target.edit(content).catch(() => {});
    return;
  }

  const attachment = new AttachmentBuilder(Buffer.from(imageBase64, 'base64'), { name: fileName });
  await target.edit({
    content,
    files: [attachment],
    attachments: [],
  }).catch(async () => {
    await target.edit(content).catch(() => {});
  });
}
