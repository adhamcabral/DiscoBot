import fs from 'fs/promises';
import { logger } from '../logger.js';
import { files, ensureRuntimeDirs } from './paths.js';
import {
    getToolStats,
    migrateToolStats,
    recordToolStats,
    resetToolStats as resetToolStatsInDb,
    type ToolStats,
} from '../database.js';

const toolsConfigPath = files.toolsConfig;

export interface ToolConfig extends ToolStats {
    name: string;
    enabled: boolean;
    description: string;
}

type ToolConfigFileEntry = {
    name: string;
    enabled: boolean;
    description: string;
    executionCount?: number;
    errorCount?: number;
    lastUsed?: string;
};

let toolsConfig: Map<string, ToolConfigFileEntry> = new Map();

function serializeConfig(config: ToolConfigFileEntry) {
    return {
        name: config.name,
        enabled: config.enabled,
        description: config.description,
    };
}

export async function loadToolsConfig(): Promise<void> {
    try {
        await ensureRuntimeDirs();
        const data = await fs.readFile(toolsConfigPath, 'utf-8');
        const configs: ToolConfigFileEntry[] = JSON.parse(data);
        toolsConfig = new Map(configs.map(config => [config.name, config]));

        const legacyStats = configs
            .filter(config => config.executionCount || config.errorCount || config.lastUsed)
            .map(config => ({
                name: config.name,
                executionCount: config.executionCount || 0,
                errorCount: config.errorCount || 0,
                lastUsed: config.lastUsed,
            }));

        if (legacyStats.length > 0) {
            await migrateToolStats(legacyStats);
            await saveToolsConfig();
        }

    } catch (error) {
        logger.warn('Arquivo de configuração de tools não encontrado, criando um novo');
        await saveToolsConfig();
    }
}

export async function saveToolsConfig(): Promise<void> {
    try {
        await ensureRuntimeDirs();
        const configs = Array.from(toolsConfig.values()).map(serializeConfig);
        await fs.writeFile(toolsConfigPath, JSON.stringify(configs, null, 2));
    } catch (error) {
        logger.error('Erro ao salvar configuração de tools:', error);
    }
}

// New MCP tools are enabled by default so deployments pick up added capabilities without manual JSON edits.
export async function registerTool(name: string, description: string): Promise<void> {
    if (!toolsConfig.has(name)) {
        toolsConfig.set(name, {
            name,
            enabled: true,
            description,
        });
        await saveToolsConfig();
    }
}

export function isToolEnabled(name: string): boolean {
    const config = toolsConfig.get(name);
    return config?.enabled ?? true;
}

export async function setToolEnabled(name: string, enabled: boolean): Promise<void> {
    const config = toolsConfig.get(name);
    if (config) {
        config.enabled = enabled;
        await saveToolsConfig();
        logger.info(`Tool ${name} ${enabled ? 'habilitada' : 'desabilitada'}`);
    }
}

export async function recordToolExecution(name: string, success: boolean): Promise<void> {
    if (toolsConfig.has(name)) {
        await recordToolStats(name, success);
    }
}

export async function getAllTools(): Promise<ToolConfig[]> {
    const tools = await Promise.all(Array.from(toolsConfig.values()).map(async (config) => ({
        ...serializeConfig(config),
        ...await getToolStats(config.name),
    })));

    return tools;
}

export function getDisabledTools(): Array<{ name: string; description: string }> {
    return Array.from(toolsConfig.values())
        .filter(config => !config.enabled)
        .map(config => ({
            name: config.name,
            description: config.description,
        }));
}

export async function resetToolStats(name: string): Promise<void> {
    if (toolsConfig.has(name)) {
        await resetToolStatsInDb(name);
        logger.info(`Estatísticas da tool ${name} resetadas`);
    }
}
