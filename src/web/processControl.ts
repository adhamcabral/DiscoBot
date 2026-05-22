import { exec } from 'child_process';
import fs from 'fs/promises';
import { files } from '../config/paths.js';

type BotProcessAction = 'start' | 'stop' | 'restart';

const actionCommands: Record<BotProcessAction, string | undefined> = {
  start: process.env.BOT_START_COMMAND || 'npm run start:bot:bg',
  stop: process.env.BOT_STOP_COMMAND || 'npm run stop',
  restart: process.env.BOT_RESTART_COMMAND || 'npm run restart',
};

function runCommand(command: string) {
  return new Promise<void>((resolve, reject) => {
    exec(command, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function markBotStopped() {
  await fs.writeFile(files.status, JSON.stringify({
    isReady: false,
    userTag: 'Offline (Parado Manualmente)',
    serverCount: 0,
    uptime: 'N/A',
    timestamp: Date.now(),
  }));
}

export async function runBotProcessAction(action: BotProcessAction) {
  const command = actionCommands[action];
  if (!command) return false;

  if (action === 'stop') {
    await markBotStopped();
  }

  await runCommand(command);
  return true;
}
