import 'dotenv/config';
import { client } from './discord/client.js';
import { initializeMcpClient, shutdownMcpClient } from './mcp/client.js';
import { initializeAi } from './ai/openaiClient.js';
import { logger } from './utils/logger.js';
import fs from 'fs/promises';
import { File } from 'node:buffer';
import { files, ensureRuntimeDirs } from './utils/paths.js';
import { Events } from 'discord.js';

// Polyfill para a classe File
if (!globalThis.File) {
  globalThis.File = File as any;
}

const statusPath = files.status;

async function writeStatus() {
    await ensureRuntimeDirs();
    const status = {
        isReady: client.isReady(),
        userTag: client.user?.tag || 'N/A',
        serverCount: client.guilds.cache.size,
        uptime: client.uptime,
        timestamp: Date.now(),
    };
    await fs.writeFile(statusPath, JSON.stringify(status, null, 2));
}

async function startBot() {
  try {
    await ensureRuntimeDirs();
    await initializeAi();

    // Inicia o cliente MCP stdio. O servidor MCP é um processo filho local.
    try {
      await initializeMcpClient();
    } catch (mcpError) {
      logger.warn('MCP stdio indisponível - bot sem ferramentas');
    }

    client.once(Events.ClientReady, (readyClient) => {
      logger.info(`${readyClient.user.tag} pronto`);

      // Escreve o status a cada 30 segundos
      setInterval(writeStatus, 30000);
      writeStatus(); // Escreve o status inicial
    });

    await client.login(process.env.DISCORD_TOKEN);

  } catch (error) {
    logger.error('Falha na inicialização do bot:', error);
    await fs.writeFile(statusPath, JSON.stringify({ isReady: false, error: 'Falha no login' }));
    await shutdownMcpClient();
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Desligando bot...');
  await shutdownMcpClient();
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Desligando bot...');
  await shutdownMcpClient();
  client.destroy();
  process.exit(0);
});

startBot();
