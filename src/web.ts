/**
 * Starts the admin panel process, which stays separate from the Discord gateway
 * so operators can inspect state and restart the bot independently.
 */
import 'dotenv/config';
import { server } from './web/server.js';
import { logger } from './logger.js';
import { initializeMcpClient } from './mcp/client.js';
import { initializeAi } from './openaiClient.js';

const PORT = process.env.PORT || 3000;

async function startWebServer() {
  await initializeAi();

  // Start the panel before MCP retries so the admin UI still loads if tools are temporarily unavailable.
  server.listen(PORT, () => {
    logger.info(`Painel web na porta ${PORT}`);
  });

  let retries = 5;
  let connected = false;

  while (retries > 0 && !connected) {
    try {
      await initializeMcpClient();
      connected = true;
    } catch (error) {
      retries--;
      if (retries > 0) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }
}

startWebServer();
