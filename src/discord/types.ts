import { DMChannel, NewsChannel, StageChannel, TextChannel, ThreadChannel, VoiceChannel } from 'discord.js';

export type WritableTextChannel = TextChannel | DMChannel | NewsChannel | ThreadChannel | VoiceChannel | StageChannel;

export type ImageCandidate = {
  url: string;
  proxyUrl?: string;
};
