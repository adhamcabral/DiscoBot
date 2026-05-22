import { DMChannel, Message, NewsChannel, StageChannel, TextChannel, ThreadChannel, VoiceChannel } from 'discord.js';
import { logger } from '../logger.js';
import type { WritableTextChannel } from './types.js';

export async function resolveWritableChannel(channel: Message['channel']): Promise<WritableTextChannel | null> {
  // Discord can deliver partial channel objects for DMs and uncached channels; fetch them before checking capabilities.
  if (channel.partial) {
    try {
      channel = await channel.fetch();
    } catch (error) {
      logger.error('Não foi possível buscar o canal parcial:', error);
      return null;
    }
  }

  if (
    channel instanceof TextChannel
    || channel instanceof DMChannel
    || channel instanceof NewsChannel
    || channel instanceof ThreadChannel
    || channel instanceof VoiceChannel
    || channel instanceof StageChannel
  ) {
    return channel;
  }

  return null;
}
