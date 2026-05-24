/**
 * Admin HTTP/WebSocket surface over persisted bot state, not direct in-memory
 * access to the Discord process.
 */
import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import { getSystemLogs, getInteractionLogs, logger } from '../logger.js';
import {
    getBlockedUsers,
    addBlockedUser,
    removeBlockedUser,
    listReminders,
    cancelReminderById,
    type ReminderRecord,
    type ReminderStatus,
} from '../database.js';
import { getAllTools, setToolEnabled, resetToolStats } from '../config/toolConfig.js';
import { getConfig, setCurrentModel, fetchAvailableModels } from '../config/botConfig.js';
import { getMcpStatus } from '../mcp/client.js';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { files, ensureRuntimeDirs } from '../config/paths.js';
import { runBotProcessAction } from './processControl.js';

const web = express();
export const server = http.createServer(web);
const wss = new WebSocketServer({ server });

const statusPath = files.status;
const promptPath = files.systemPrompt;
const systemLogPath = files.systemLog;
const interactionLogPath = files.interactionLog;
const remindersSignalPath = files.remindersSignal;

web.set('view engine', 'ejs');
web.set('views', path.join(process.cwd(), 'views'));
web.use(express.static(path.join(process.cwd(), 'public')));
web.use(express.urlencoded({ extended: true }));
web.use(express.json());

async function getFullState() {
    const [botStatus, systemLogs, interactionLogs, blockedUserIds, tools, botConfig, mcpStatus, reminders] = await Promise.all([
        getBotStatus(),
        getSystemLogs(),
        getInteractionLogs(),
        getBlockedUsers(),
        getAllTools(),
        Promise.resolve(getConfig()),
        Promise.resolve(getMcpStatus()),
        getReminderPanelState(),
    ]);
    const blockedUsers = blockedUserIds.map(id => ({ id, tag: id }));
    return { botStatus, systemLogs, interactionLogs, blockedUsers, tools, botConfig, mcpStatus, reminders };
}

function formatReminderForPanel(reminder: ReminderRecord) {
    const timezone = reminder.timezone
        || process.env.BOT_TIMEZONE
        || process.env.TZ
        || Intl.DateTimeFormat().resolvedOptions().timeZone
        || 'America/Sao_Paulo';

    let localDueAt = reminder.dueAt;
    try {
        localDueAt = new Intl.DateTimeFormat('pt-BR', {
            dateStyle: 'short',
            timeStyle: 'short',
            timeZone: timezone,
        }).format(new Date(reminder.dueAt));
    } catch {
        localDueAt = new Date(reminder.dueAt).toLocaleString('pt-BR');
    }

    return {
        ...reminder,
        localDueAt,
        timezone,
    };
}

async function getReminderPanelState() {
    const items = (await listReminders({ limit: 100 })).map(formatReminderForPanel);
    const counts = items.reduce((acc, reminder) => {
        acc[reminder.status] = (acc[reminder.status] || 0) + 1;
        return acc;
    }, {} as Record<ReminderStatus, number>);

    return { items, counts };
}

// The panel is state-push based: filesystem watchers trigger this when the bot writes status/log/signal files.
async function broadcastState() {
    const state = await getFullState();
    const stateString = JSON.stringify({ type: 'UPDATE_STATE', payload: state });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(stateString);
        }
    });
}

async function watchRuntimeFile(filePath: string) {
    try {
        const handle = await fs.open(filePath, 'a');
        await handle.close();
        const watcher = fs.watch(filePath);
        for await (const _event of watcher) {
            await broadcastState();
        }
    } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        logger.error(`Erro ao observar o arquivo ${filePath}:`, err);
    }
}

void (async () => {
    await ensureRuntimeDirs();
    await Promise.all([statusPath, systemLogPath, interactionLogPath, remindersSignalPath].map(watchRuntimeFile));
})();


wss.on('connection', (_ws) => {
    logger.debug('Cliente conectado ao painel via WebSocket.');
    broadcastState();
});

async function getBotStatus() {
    try {
        const data = await fs.readFile(statusPath, 'utf-8');
        const status = JSON.parse(data);
        const isOutdated = (Date.now() - status.timestamp) > 45000;
        if (isOutdated) return { isReady: false, userTag: 'Offline (Sem Sinal)', serverCount: 0, uptime: 'N/A' };
        if (status.uptime) status.uptime = (status.uptime / 1000 / 60).toFixed(2) + ' minutos';
        return status;
    } catch (error) {
        return { isReady: false, userTag: 'Offline', serverCount: 0, uptime: 'N/A' };
    }
}

web.get('/', async (_req, res) => {
  try {
    const promptContent = await fs.readFile(promptPath, 'utf-8');
    res.render('index_new', { promptContent });
  } catch (error) {
    logger.error("Erro ao carregar o painel:", error);
    res.status(500).send("Erro ao carregar o painel.");
  }
});

web.post('/bot-control', async (req, res) => {
    const { action } = req.body;

    if (['start', 'stop', 'restart'].includes(action)) {
        try {
            await runBotProcessAction(action);
        } catch (error) {
            logger.error(`Falha ao executar a ação '${action}':`, error);
        }
    }

    res.redirect('/');
});

web.post('/block', async (req, res) => {
  const { userId } = req.body;
  if (userId) await addBlockedUser(userId);
  res.redirect('/');
});

web.post('/unblock', async (req, res) => {
  const { userId } = req.body;
  if (userId) await removeBlockedUser(userId);
  res.redirect('/');
});

web.post('/reminder/cancel', async (req, res) => {
  const { reminderId } = req.body;
  if (!reminderId || typeof reminderId !== 'string') {
    res.status(400).json({ success: false, error: 'reminderId é obrigatório' });
    return;
  }

  try {
    const reminder = await cancelReminderById(reminderId);
    await broadcastState();
    res.json({ success: Boolean(reminder), reminder: reminder ? formatReminderForPanel(reminder) : null });
  } catch (error) {
    logger.error(`Erro ao cancelar lembrete ${reminderId}:`, error);
    res.status(500).json({ success: false, error: String(error) });
  }
});

web.post('/save-prompt', async (req, res) => {
  const { prompt } = req.body;
  try {
    await fs.writeFile(promptPath, prompt);
    logger.info("System prompt atualizado. Reiniciando o bot...");
    await runBotProcessAction('restart');
    res.redirect('/');
  } catch (error) {
    logger.error(`Falha ao salvar ${promptPath}:`, error);
    res.status(500).send("Erro ao salvar o prompt.");
  }
});

web.post('/tool/toggle', async (req, res) => {
  const { toolName, enabled } = req.body;
  try {
    await setToolEnabled(toolName, enabled === 'true');
    await broadcastState();
    res.json({ success: true });
  } catch (error) {
    logger.error(`Erro ao alternar tool ${toolName}:`, error);
    res.status(500).json({ success: false, error: String(error) });
  }
});

web.post('/tool/reset', async (req, res) => {
  const { toolName } = req.body;
  try {
    await resetToolStats(toolName);
    await broadcastState();
    res.json({ success: true });
  } catch (error) {
    logger.error(`Erro ao resetar estatísticas da tool ${toolName}:`, error);
    res.status(500).json({ success: false, error: String(error) });
  }
});

web.post('/model/set', async (req, res) => {
  const { model } = req.body;
  try {
    await setCurrentModel(model);
    await broadcastState();
    res.json({ success: true });
  } catch (error) {
    logger.error(`Erro ao alterar modelo:`, error);
    res.status(500).json({ success: false, error: String(error) });
  }
});

web.post('/model/refresh', async (_req, res) => {
  try {
    const models = await fetchAvailableModels();
    await broadcastState();
    res.json({ success: true, models });
  } catch (error) {
    logger.error(`Erro ao buscar modelos:`, error);
    res.status(500).json({ success: false, error: String(error) });
  }
});
