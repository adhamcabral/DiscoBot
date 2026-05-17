import { DMChannel, Message, NewsChannel, StageChannel, TextChannel, ThreadChannel, VoiceChannel } from 'discord.js';
import { logger } from '../utils/logger.js';
import type { WritableTextChannel } from './types.js';

export async function getSafeWritableChannel(channel: Message['channel']): Promise<WritableTextChannel | null> {
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
