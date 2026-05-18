import type { Client } from 'discord.js';
import {
  getDueReminders,
  getNextPendingReminder,
  markReminderFailed,
  markReminderSent,
  type ReminderRecord,
} from '../utils/database.js';
import { logger } from '../utils/logger.js';

const MAX_DUE_PER_TICK = 25;
const MAX_TIMEOUT_MS = 2_147_483_647;
const MIN_TIMEOUT_MS = 100;

let activeClient: Client | null = null;
let schedulerTimer: NodeJS.Timeout | null = null;
let isTickRunning = false;
const inFlightReminderIds = new Set<string>();

type SendableTextChannel = {
  isTextBased: () => boolean;
  send: (content: string) => Promise<unknown>;
};

function canSendMessage(channel: unknown): channel is SendableTextChannel {
  return Boolean(channel && typeof (channel as { isTextBased?: () => boolean }).isTextBased === 'function'
    && (channel as { isTextBased: () => boolean }).isTextBased()
    && typeof (channel as { send?: unknown }).send === 'function');
}

function renderReminderMessage(reminder: ReminderRecord) {
  return [
    `<@${reminder.userId}> lembrete:`,
    reminder.text,
  ].join('\n');
}

async function deliverReminder(client: Client, reminder: ReminderRecord) {
  if (inFlightReminderIds.has(reminder.id)) return;
  inFlightReminderIds.add(reminder.id);

  try {
    const channel = await client.channels.fetch(reminder.channelId);
    if (!canSendMessage(channel)) {
      throw new Error(`Canal ${reminder.channelId} não encontrado ou não aceita mensagens.`);
    }

    await channel.send(renderReminderMessage(reminder));
    await markReminderSent(reminder.id);
    logger.info(`Lembrete ${reminder.id} entregue para ${reminder.userId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markReminderFailed(reminder.id, message);
    logger.error(`Falha ao entregar lembrete ${reminder.id}:`, error);
  } finally {
    inFlightReminderIds.delete(reminder.id);
  }
}

async function tickReminderScheduler(client: Client) {
  if (!client.isReady() || isTickRunning) return;

  isTickRunning = true;
  try {
    while (client.isReady()) {
      const reminders = await getDueReminders(new Date().toISOString(), MAX_DUE_PER_TICK);
      if (reminders.length === 0) break;

      for (const reminder of reminders) {
        await deliverReminder(client, reminder);
      }

      if (reminders.length < MAX_DUE_PER_TICK) break;
    }
  } catch (error) {
    logger.error('Erro no scheduler de lembretes:', error);
  } finally {
    isTickRunning = false;
  }
}

function clearSchedulerTimer() {
  if (!schedulerTimer) return;
  clearTimeout(schedulerTimer);
  schedulerTimer = null;
}

async function scheduleNextReminder() {
  const client = activeClient;
  if (!client?.isReady()) return;

  clearSchedulerTimer();

  await tickReminderScheduler(client);

  const nextReminder = await getNextPendingReminder();
  if (!nextReminder) {
    logger.debug('Scheduler de lembretes sem pendências');
    return;
  }

  const dueTime = Date.parse(nextReminder.dueAt);
  const delay = Number.isFinite(dueTime) ? dueTime - Date.now() : 0;
  const safeDelay = Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, delay));

  schedulerTimer = setTimeout(() => {
    void scheduleNextReminder();
  }, safeDelay);

  logger.debug(`Próximo lembrete agendado: ${nextReminder.id} em ${safeDelay}ms`);
}

export function notifyReminderScheduleChanged() {
  if (!activeClient?.isReady()) return;
  void scheduleNextReminder();
}

export function startReminderScheduler(client: Client) {
  activeClient = client;

  void scheduleNextReminder();
  logger.info('Scheduler de lembretes iniciado');
}

export function stopReminderScheduler() {
  clearSchedulerTimer();
  activeClient = null;
  logger.info('Scheduler de lembretes parado');
}
