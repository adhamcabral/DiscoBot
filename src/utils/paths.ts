import fs from 'fs/promises';
import path from 'path';

export const rootPath = process.cwd();
export const personalityPath = path.join(rootPath, 'personality');
export const dataPath = path.join(rootPath, 'data');
export const configPath = path.join(dataPath, 'config');
export const statePath = path.join(dataPath, 'state');
export const logsPath = path.join(dataPath, 'logs');

export const files = {
  systemPrompt: path.join(personalityPath, 'system_prompt.md'),
  botConfig: path.join(configPath, 'bot.json'),
  toolsConfig: path.join(configPath, 'tools.json'),
  legacyDatabaseJson: path.join(statePath, 'db.json'),
  database: path.join(statePath, 'bot.sqlite'),
  status: path.join(statePath, 'status.json'),
  systemLog: path.join(logsPath, 'system.log'),
  interactionLog: path.join(logsPath, 'interaction.log'),
};

export async function ensureRuntimeDirs() {
  await Promise.all([
    fs.mkdir(personalityPath, { recursive: true }),
    fs.mkdir(configPath, { recursive: true }),
    fs.mkdir(statePath, { recursive: true }),
    fs.mkdir(logsPath, { recursive: true }),
  ]);
}
