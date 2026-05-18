import fs from 'fs';
import OpenAI from 'openai';
import type { ChatCompletionMessage, ChatCompletionMessageParam } from 'openai/resources/index.js';
import { getOpenAiTools } from '../mcp/client.js';
import { loadConfig, getCurrentModel, updateModelsIfNeeded } from '../utils/configManager.js';
import { logger } from '../utils/logger.js';
import { files } from '../utils/paths.js';

let systemPromptTemplate = 'Você é um assistente prestativo.';

try {
  systemPromptTemplate = fs.readFileSync(files.systemPrompt, 'utf-8');
} catch (error) {
  logger.error(`Não foi possível carregar ${files.systemPrompt}. Usando prompt padrão.`, error);
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function initializeAi() {
  await loadConfig();
  await updateModelsIfNeeded();
}

function getRuntimeContext() {
  const now = new Date();
  const timezone = process.env.BOT_TIMEZONE
    || process.env.TZ
    || Intl.DateTimeFormat().resolvedOptions().timeZone
    || 'America/Sao_Paulo';
  const localNow = new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'full',
    timeStyle: 'medium',
    timeZone: timezone,
  }).format(now);

  return [
    '## Contexto de runtime',
    `Agora em UTC ISO: ${now.toISOString()}`,
    `Agora no timezone local do bot (${timezone}): ${localNow}`,
    `Timezone padrão para o usuário: ${timezone}`,
    'Para lembretes relativos como "em 5 minutos", "daqui 2 horas" ou "em 3 dias", prefira chamar schedule_reminder com delaySeconds em vez de calcular dueAt manualmente.',
    'Para lembretes com data/hora absoluta, use dueAt em ISO 8601 com offset/timezone explícito. Se faltar data, hora ou texto, peça esclarecimento antes de agendar.',
  ].join('\n');
}

export async function getNextAction(
  messages: ChatCompletionMessageParam[],
  currentUser: { id: string; name: string },
  timeout = 900000,
): Promise<ChatCompletionMessage> {
  const populatedPrompt = systemPromptTemplate
    .replace('{{currentUser.name}}', currentUser.name)
    .replace('{{currentUser.id}}', currentUser.id);

  const response = await openai.chat.completions.create({
    model: getCurrentModel(),
    messages: [
      {
        role: 'system',
        content: `${populatedPrompt}\n\n${getRuntimeContext()}`,
      },
      ...messages,
    ],
    tools: await getOpenAiTools(),
    tool_choice: 'auto',
  }, {
    timeout,
  });

  return response.choices[0].message;
}
