import { Client, GatewayIntentBits, Partials, Message } from 'discord.js';
import { handleMessage } from './messageHandler.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.on('messageCreate', async (message: Message) => {
  if (message.author.bot) return;

  const isMentioned = message.mentions.has(client.user?.id || '');
  const isDM = !message.guild;

  if (isMentioned || isDM) {
    await handleMessage(message);
  }
});

export { client };
