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
        content: populatedPrompt,
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
