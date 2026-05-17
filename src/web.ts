import 'dotenv/config';
import { server } from './web/server.js'; // Importa o servidor HTTP
import { logger } from './utils/logger.js';
import { initializeMcpClient } from './mcp/client.js';
import { initializeAi } from './ai/openaiClient.js';

const PORT = process.env.PORT || 3000;

async function startWebServer() {
  await initializeAi();

  // Inicia o servidor primeiro
  server.listen(PORT, () => {
    logger.info(`Painel web na porta ${PORT}`);
  });

  // Tenta conectar ao Tools Server com retries (silenciosamente)
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
