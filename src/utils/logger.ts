import { WebhookClient, EmbedBuilder, Message } from 'discord.js';
import fs from 'fs/promises';
import path from 'path';
import { files } from './paths.js';

const systemLogPath = files.systemLog;
const interactionLogPath = files.interactionLog;

const webhookUrl = process.env.LOG_WEBHOOK_URL;
const logLevel = (process.env.LOG_LEVEL || 'info').toUpperCase();
const webhookInfoEnabled = process.env.LOG_WEBHOOK_INFO === 'true';
let webhookClient: WebhookClient | null = null;
if (webhookUrl) {
  try {
    webhookClient = new WebhookClient({ url: webhookUrl });
  } catch (error) {
    console.error("URL de Webhook inválida:", error);
  }
}

function shouldWrite(level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR') {
  const priority = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
  return priority[level] >= (priority[logLevel as keyof typeof priority] ?? priority.INFO);
}

function sendWebhook(level: 'INFO' | 'WARN' | 'ERROR', message: string, error?: any) {
  if (!webhookClient) return;
  if (level === 'INFO' && !webhookInfoEnabled) return;

  const color = { INFO: 0x0099ff, WARN: 0xffcc00, ERROR: 0xff0000 }[level];
  const embed = new EmbedBuilder().setTitle(`Log de ${level}`).setDescription(message).setColor(color).setTimestamp();
  if (error) {
    const errorMessage = error instanceof Error ? error.stack || error.message : String(error);
    embed.addFields({ name: 'Detalhes do Erro', value: `\`\`\`${errorMessage.substring(0, 1010)}\`\`\`` });
  }
  webhookClient.send({ username: 'Bot Logger', embeds: [embed] }).catch(console.error);
}

async function appendLog(filePath: string, line: string) {
    try {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.appendFile(filePath, line + '\n');
    } catch (error) {
        console.error(`Falha ao escrever no arquivo de log ${filePath}:`, error);
    }
}

async function readLastLines(filePath: string, maxLines: number) {
    try {
        const data = await fs.readFile(filePath, 'utf-8');
        return data.split('\n').filter(Boolean).slice(-maxLines);
    } catch (error) {
        return [];
    }
}

export async function logInteraction(message: Message, responseText: string, toolsUsed: string[] = [], toolDetails: string[] = []) {
  const logEntry = {
    author: { tag: message.author.tag, id: message.author.id, avatarURL: message.author.displayAvatarURL() },
    question: message.content,
    answer: responseText,
    toolsUsed: toolsUsed,
    toolDetails,
    guild: message.guild ? { name: message.guild.name, id: message.guild.id } : null,
    timestamp: new Date(),
  };
  await appendLog(interactionLogPath, JSON.stringify(logEntry));

  if (!webhookClient) return;
  const embed = new EmbedBuilder()
    .setColor(0x00ff00)
    .setTitle('Nova Interação com IA')
    .setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL() })
    .addFields(
      { name: 'Usuário', value: `${message.author.tag} (\`${message.author.id}\`)`, inline: true },
      { name: 'Local', value: message.guild ? `${message.guild.name} (\`${message.guild.id}\`)` : 'Mensagem Direta', inline: true },
      { name: 'Pergunta', value: (message.content.substring(0, 1020) || '*Nenhum texto*') },
      { name: 'Resposta do Bot', value: (responseText.substring(0, 1020) || '*Nenhuma resposta*') }
    )
    .setTimestamp();
  if (toolsUsed.length > 0) {
    embed.addFields({ name: 'Ferramentas Usadas', value: `\`${toolsUsed.join(', ')}\`` });
  }
  if (toolDetails.length > 0) {
    embed.addFields({ name: 'Resumo das Ferramentas', value: toolDetails.join('\n').slice(0, 1020) });
  }
  const attachment = message.attachments.first();
  if (attachment) {
    embed.addFields({ name: 'Anexo', value: attachment.url });
    if (attachment.contentType?.startsWith('image/')) {
      embed.setImage(attachment.url);
    }
  }
  webhookClient.send({ username: 'Bot Interaction Logs', embeds: [embed] }).catch(console.error);
}

export async function getSystemLogs() {
    const lines = await readLastLines(systemLogPath, 50);
    return lines.map(line => {
        const match = line.match(/\[(.*?)\] \[(.*?)\] (.*)/);
        if (match) {
            return { timestamp: new Date(match[1]), level: match[2], message: match[3] };
        }
        return { timestamp: new Date(), level: 'INFO', message: line };
    }).reverse();
}

export async function getInteractionLogs() {
    const lines = await readLastLines(interactionLogPath, 50);
    return lines.map(line => JSON.parse(line)).reverse();
}

export const logger = {
  debug: (message: string) => {
    if (!shouldWrite('DEBUG')) return;

    const line = `[${new Date().toISOString()}] [DEBUG] ${message}`;
    console.debug(line);
    appendLog(systemLogPath, line);
  },
  info: (message: string) => {
    if (!shouldWrite('INFO')) return;

    const line = `[${new Date().toISOString()}] [INFO] ${message}`;
    console.log(line);
    appendLog(systemLogPath, line);
    sendWebhook('INFO', message);
  },
  warn: (message: string) => {
    if (!shouldWrite('WARN')) return;

    const line = `[${new Date().toISOString()}] [WARN] ${message}`;
    console.warn(line);
    appendLog(systemLogPath, line);
    sendWebhook('WARN', message);
  },
  error: (message: string, error?: any) => {
    if (!shouldWrite('ERROR')) return;

    const errorMsg = error instanceof Error ? error.stack || error.message : error ? String(error) : '';
    const line = `[${new Date().toISOString()}] [ERROR] ${message}${errorMsg ? ` - ${errorMsg}` : ''}`;
    console.error(line);
    appendLog(systemLogPath, line);
    sendWebhook('ERROR', message, error);
  },
};
