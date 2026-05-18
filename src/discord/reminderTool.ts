import { randomUUID } from 'crypto';
import type { Message } from 'discord.js';
import {
  cancelReminder,
  createReminder,
  listPendingRemindersForUser,
  type ReminderRecord,
} from '../utils/database.js';
import { notifyReminderScheduleChanged } from './reminderScheduler.js';
import type { WritableTextChannel } from './types.js';

type ReminderAction = 'create' | 'list' | 'cancel';

type ScheduleReminderArgs = {
  action?: unknown;
  text?: unknown;
  dueAt?: unknown;
  delaySeconds?: unknown;
  timezone?: unknown;
  reminderId?: unknown;
  limit?: unknown;
};

function jsonText(value: unknown) {
  return JSON.stringify(value);
}

function getAction(value: unknown): ReminderAction {
  return value === 'list' || value === 'cancel' ? value : 'create';
}

function getString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function getLimit(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 20;
  return Math.max(1, Math.min(50, Math.floor(value)));
}

function getDelaySeconds(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.min(366 * 24 * 60 * 60, Math.floor(value)));
}

function getDefaultTimezone() {
  return process.env.BOT_TIMEZONE
    || process.env.TZ
    || Intl.DateTimeFormat().resolvedOptions().timeZone
    || 'America/Sao_Paulo';
}

function parseDueAt(value: unknown) {
  const raw = getString(value);
  if (!raw) return undefined;

  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) return undefined;

  return new Date(timestamp);
}

function resolveDueAt(args: ScheduleReminderArgs) {
  const delaySeconds = getDelaySeconds(args.delaySeconds);
  if (delaySeconds) {
    return {
      date: new Date(Date.now() + delaySeconds * 1000),
      source: 'delaySeconds',
      delaySeconds,
    };
  }

  const dueAt = parseDueAt(args.dueAt);
  if (!dueAt) return undefined;

  return {
    date: dueAt,
    source: 'dueAt',
    delaySeconds: undefined,
  };
}

function formatLocalDateTime(iso: string, timezone?: string) {
  const targetTimezone = timezone || getDefaultTimezone();

  try {
    return new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone: targetTimezone,
    }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone: getDefaultTimezone(),
    }).format(new Date(iso));
  }
}

function formatReminder(reminder: ReminderRecord) {
  const timezone = reminder.timezone || getDefaultTimezone();

  return {
    id: reminder.id,
    text: reminder.text,
    dueAt: reminder.dueAt,
    localDueAt: formatLocalDateTime(reminder.dueAt, timezone),
    timezone,
    status: reminder.status,
    channelId: reminder.channelId,
    guildId: reminder.guildId || null,
    createdAt: reminder.createdAt,
  };
}

async function createScheduledReminder(
  channel: WritableTextChannel,
  triggerMessage: Message,
  args: ScheduleReminderArgs,
) {
  const text = getString(args.text);
  const resolvedDueAt = resolveDueAt(args);
  const timezone = getString(args.timezone) || getDefaultTimezone();

  if (!text) {
    return jsonText({
      success: false,
      error: 'Informe o texto do lembrete em text.',
    });
  }

  if (!resolvedDueAt) {
    return jsonText({
      success: false,
      error: 'Informe dueAt como data ISO 8601 válida ou delaySeconds como número de segundos no futuro.',
    });
  }

  const dueAt = resolvedDueAt.date;

  if (dueAt.getTime() <= Date.now()) {
    return jsonText({
      success: false,
      error: 'A data do lembrete precisa estar no futuro.',
      now: new Date().toISOString(),
    });
  }

  const reminder = await createReminder({
    id: `rem_${randomUUID()}`,
    userId: triggerMessage.author.id,
    channelId: channel.id,
    guildId: triggerMessage.guild?.id,
    messageId: triggerMessage.id,
    text,
    dueAt: dueAt.toISOString(),
    timezone,
  });

  notifyReminderScheduleChanged();

  return jsonText({
    success: true,
    action: 'create',
    scheduledFrom: resolvedDueAt.source,
    delaySeconds: resolvedDueAt.delaySeconds,
    reminder: formatReminder(reminder),
    instruction: 'Confirme o lembrete em português usando reminder.localDueAt e reminder.timezone. Não converta para UTC na resposta ao usuário. Inclua o ID caso ele queira cancelar depois.',
  });
}

async function listScheduledReminders(triggerMessage: Message, args: ScheduleReminderArgs) {
  const reminders = await listPendingRemindersForUser(triggerMessage.author.id, getLimit(args.limit));

  return jsonText({
    success: true,
    action: 'list',
    reminders: reminders.map(formatReminder),
    count: reminders.length,
    instruction: reminders.length > 0
      ? 'Liste os lembretes pendentes em português usando localDueAt/timezone. Não apresente UTC como horário principal.'
      : 'Diga em português que o usuário não tem lembretes pendentes.',
  });
}

async function cancelScheduledReminder(triggerMessage: Message, args: ScheduleReminderArgs) {
  let reminderId = getString(args.reminderId);

  if (!reminderId) {
    const pendingReminders = await listPendingRemindersForUser(triggerMessage.author.id, 2);

    if (pendingReminders.length === 1) {
      reminderId = pendingReminders[0].id;
    } else {
      return jsonText({
        success: false,
        action: 'cancel',
        error: pendingReminders.length === 0
          ? 'Este usuário não tem lembretes pendentes para cancelar.'
          : 'Há mais de um lembrete pendente. Informe reminderId para cancelar o lembrete correto.',
        pendingReminders: pendingReminders.map(formatReminder),
        instruction: pendingReminders.length === 0
          ? 'Diga em português que não há lembretes pendentes para cancelar. Não diga que cancelou.'
          : 'Diga em português que há mais de um lembrete pendente e peça o ID. Não diga que cancelou.',
      });
    }
  }

  const reminder = await cancelReminder(reminderId, triggerMessage.author.id);

  if (!reminder) {
    return jsonText({
      success: false,
      action: 'cancel',
      reminderId,
      error: 'Lembrete pendente não encontrado para este usuário.',
      instruction: 'Diga em português que não encontrou um lembrete pendente com esse ID. Não diga que cancelou.',
    });
  }

  notifyReminderScheduleChanged();

  return jsonText({
    success: true,
    action: 'cancel',
    reminder: formatReminder(reminder),
    instruction: 'Confirme em português que o lembrete foi cancelado.',
  });
}

export async function scheduleReminder(
  channel: WritableTextChannel,
  triggerMessage: Message,
  args: ScheduleReminderArgs,
) {
  const action = getAction(args.action);

  if (action === 'list') {
    return listScheduledReminders(triggerMessage, args);
  }

  if (action === 'cancel') {
    return cancelScheduledReminder(triggerMessage, args);
  }

  return createScheduledReminder(channel, triggerMessage, args);
}
