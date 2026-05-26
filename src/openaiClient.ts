/**
 * Builds OpenAI chat turns from prompt, runtime context, conversation history,
 * selected model, and currently enabled MCP tool schemas.
 */
import fs from 'fs';
import OpenAI from 'openai';
import type { ChatCompletionMessage, ChatCompletionMessageParam } from 'openai/resources/index.js';
import { getOpenAiTools } from './mcp/client.js';
import { loadConfig, getCurrentModel, updateModelsIfNeeded } from './config/botConfig.js';
import { getDisabledTools, loadToolsConfig } from './config/toolConfig.js';
import { logger } from './logger.js';
import { files } from './config/paths.js';

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

async function getRuntimeContext() {
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

  await loadToolsConfig();
  const disabledTools = getDisabledTools();
  const disabledToolContext = disabledTools.length > 0
    ? [
      '## Ferramentas desabilitadas pelo painel',
      ...disabledTools.map(tool => `- ${tool.name}: ${tool.description}`),
      'Se o pedido do usuário exigir uma ferramenta desabilitada, não use outra ferramenta como substituta. Diga de forma natural que essa capacidade está desabilitada no momento.',
    ].join('\n')
    : '## Ferramentas desabilitadas pelo painel\nNenhuma.';

  return [
    '## Contexto de runtime',
    `Agora em UTC ISO: ${now.toISOString()}`,
    `Agora no timezone local do bot (${timezone}): ${localNow}`,
    `Timezone padrão para o usuário: ${timezone}`,
    'Para lembretes relativos como "em 5 minutos", "daqui 2 horas" ou "em 3 dias", prefira chamar schedule_reminder com delaySeconds em vez de calcular dueAt manualmente.',
    'Para lembretes com data/hora absoluta, use dueAt em ISO 8601 com offset/timezone explícito. Se faltar data, hora ou texto, peça esclarecimento antes de agendar.',
    disabledToolContext,
  ].join('\n');
}

// Builds a single assistant turn with the latest tool list, so toggles in the admin panel affect future calls.
export async function getNextAction(
  messages: ChatCompletionMessageParam[],
  currentUser: { id: string; name: string },
  timeout = 900000,
): Promise<ChatCompletionMessage> {
  const populatedPrompt = systemPromptTemplate
    .replace('{{currentUser.name}}', currentUser.name)
    .replace('{{currentUser.id}}', currentUser.id);

  const runtimeContext = await getRuntimeContext();
  const response = await openai.chat.completions.create({
    model: getCurrentModel(),
    messages: [
      {
        role: 'system',
        content: `${populatedPrompt}\n\n${runtimeContext}`,
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
