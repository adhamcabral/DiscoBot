import fs from 'fs/promises';
import { logger } from '../logger.js';
import OpenAI from 'openai';
import { files, ensureRuntimeDirs } from './paths.js';

const configPath = files.botConfig;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export interface BotConfig {
    model: string;
    availableModels: string[];
    lastModelsUpdate: string;
}

let currentConfig: BotConfig = {
    model: 'gpt-4o-mini',
    availableModels: ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo'],
    lastModelsUpdate: new Date().toISOString(),
};

export async function loadConfig(): Promise<void> {
    try {
        await ensureRuntimeDirs();
        const data = await fs.readFile(configPath, 'utf-8');
        currentConfig = JSON.parse(data);
    } catch (error) {
        logger.warn('Arquivo de configuração não encontrado, criando um novo');
        await saveConfig();
    }
}

export async function saveConfig(): Promise<void> {
    try {
        await ensureRuntimeDirs();
        await fs.writeFile(configPath, JSON.stringify(currentConfig, null, 2));
    } catch (error) {
        logger.error('Erro ao salvar configuração:', error);
    }
}

export function getConfig(): BotConfig {
    return currentConfig;
}

export function getCurrentModel(): string {
    return currentConfig.model;
}

export async function setCurrentModel(model: string): Promise<void> {
    currentConfig.model = model;
    await saveConfig();
    logger.info(`Modelo alterado para: ${model}`);
}

// Refreshes the selectable model list from the account instead of hard-coding model availability.
export async function fetchAvailableModels(): Promise<string[]> {
    try {
        const response = await openai.models.list();

        const chatModels = response.data
            .filter(model =>
                model.id.includes('gpt') &&
                !model.id.includes('instruct') &&
                !model.id.includes('vision') &&
                !model.id.includes('audio')
            )
            .map(model => model.id)
            .sort((a, b) => {
                const order = ['gpt-4o', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo'];
                const aPrefix = order.find(prefix => a.startsWith(prefix)) || '';
                const bPrefix = order.find(prefix => b.startsWith(prefix)) || '';
                const aIndex = order.indexOf(aPrefix);
                const bIndex = order.indexOf(bPrefix);
                if (aIndex !== bIndex) {
                    return aIndex - bIndex;
                }
                return b.localeCompare(a);
            });

        currentConfig.availableModels = chatModels;
        currentConfig.lastModelsUpdate = new Date().toISOString();
        await saveConfig();

        logger.info(`${chatModels.length} modelos disponíveis atualizados`);
        return chatModels;
    } catch (error) {
        logger.error('Erro ao buscar modelos da OpenAI:', error);
        return currentConfig.availableModels;
    }
}

// Model listing is cached because it is operational metadata, not something needed on every request.
export async function updateModelsIfNeeded(): Promise<void> {
    const lastUpdate = new Date(currentConfig.lastModelsUpdate);
    const now = new Date();
    const hoursSinceUpdate = (now.getTime() - lastUpdate.getTime()) / (1000 * 60 * 60);

    if (hoursSinceUpdate >= 24) {
        logger.debug('Atualizando lista de modelos disponíveis...');
        await fetchAvailableModels();
    }
}
