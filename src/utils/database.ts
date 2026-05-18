import fs from 'fs/promises';
import Database from 'better-sqlite3';
import { files, ensureRuntimeDirs } from './paths.js';
import { logger } from './logger.js';

type LegacyDatabase = {
  blockedUsers?: string[];
};

export type ToolStats = {
  executionCount: number;
  errorCount: number;
  lastUsed?: string;
};

export type ReminderStatus = 'pending' | 'sent' | 'cancelled' | 'failed';

export type ReminderRecord = {
  id: string;
  userId: string;
  channelId: string;
  guildId?: string;
  messageId?: string;
  text: string;
  dueAt: string;
  timezone?: string;
  status: ReminderStatus;
  createdAt: string;
  updatedAt: string;
  sentAt?: string;
  error?: string;
};

let db: Database.Database | null = null;

function getDb() {
  if (!db) {
    db = new Database(files.database);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE IF NOT EXISTS blocked_users (
        user_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS tool_stats (
        tool_name TEXT PRIMARY KEY,
        execution_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        last_used TEXT
      );

      CREATE TABLE IF NOT EXISTS reminders (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        guild_id TEXT,
        message_id TEXT,
        text TEXT NOT NULL,
        due_at TEXT NOT NULL,
        timezone TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        sent_at TEXT,
        error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_reminders_due
        ON reminders (status, due_at);

      CREATE INDEX IF NOT EXISTS idx_reminders_user
        ON reminders (user_id, status, due_at);
    `);
  }

  return db;
}

async function hardenDatabaseFile() {
  try {
    await fs.chmod(files.database, 0o600);
  } catch (error) {
    logger.warn(`Não foi possível ajustar permissões do SQLite: ${String(error)}`);
  }
}

async function migrateLegacyJson() {
  try {
    const raw = await fs.readFile(files.legacyDatabaseJson, 'utf-8');
    const legacy = JSON.parse(raw) as LegacyDatabase;

    const blockedUsers = Array.isArray(legacy.blockedUsers) ? legacy.blockedUsers : [];

    if (blockedUsers.length > 0) {
      const insert = getDb().prepare('INSERT OR IGNORE INTO blocked_users (user_id) VALUES (?)');
      const insertMany = getDb().transaction((userIds: string[]) => {
        for (const userId of userIds) {
          insert.run(userId);
        }
      });

      insertMany(blockedUsers);
    }

    await fs.rename(files.legacyDatabaseJson, `${files.legacyDatabaseJson}.migrated`);
    logger.info(`Migrados ${blockedUsers.length} usuário(s) bloqueado(s) para SQLite`);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code !== 'ENOENT') {
      logger.warn(`Não foi possível migrar o JSON legado para SQLite: ${String(error)}`);
    }
  }
}

async function initializeDatabase() {
  await ensureRuntimeDirs();
  getDb();
  await hardenDatabaseFile();
  await migrateLegacyJson();
}

async function notifyReminderStateChanged() {
  try {
    await ensureRuntimeDirs();
    await fs.writeFile(files.remindersSignal, JSON.stringify({ updatedAt: new Date().toISOString() }));
  } catch (error) {
    logger.warn(`Não foi possível sinalizar atualização de lembretes: ${String(error)}`);
  }
}

export async function getBlockedUsers(): Promise<string[]> {
  await initializeDatabase();
  const rows = getDb().prepare('SELECT user_id FROM blocked_users ORDER BY created_at ASC').all() as Array<{ user_id: string }>;
  return rows.map((row) => row.user_id);
}

export async function addBlockedUser(userId: string): Promise<void> {
  await initializeDatabase();
  getDb().prepare('INSERT OR IGNORE INTO blocked_users (user_id) VALUES (?)').run(userId);
}

export async function removeBlockedUser(userId: string): Promise<void> {
  await initializeDatabase();
  getDb().prepare('DELETE FROM blocked_users WHERE user_id = ?').run(userId);
}

export async function migrateToolStats(stats: Array<{ name: string } & ToolStats>): Promise<void> {
  await initializeDatabase();

  const insert = getDb().prepare(`
    INSERT INTO tool_stats (tool_name, execution_count, error_count, last_used)
    VALUES (@name, @executionCount, @errorCount, @lastUsed)
    ON CONFLICT(tool_name) DO UPDATE SET
      execution_count = MAX(tool_stats.execution_count, excluded.execution_count),
      error_count = MAX(tool_stats.error_count, excluded.error_count),
      last_used = COALESCE(tool_stats.last_used, excluded.last_used)
  `);

  const insertMany = getDb().transaction((items: Array<{ name: string } & ToolStats>) => {
    for (const item of items) {
      insert.run({
        name: item.name,
        executionCount: item.executionCount || 0,
        errorCount: item.errorCount || 0,
        lastUsed: item.lastUsed || null,
      });
    }
  });

  insertMany(stats);
}

export async function getToolStats(toolName: string): Promise<ToolStats> {
  await initializeDatabase();
  const row = getDb()
    .prepare('SELECT execution_count, error_count, last_used FROM tool_stats WHERE tool_name = ?')
    .get(toolName) as { execution_count: number; error_count: number; last_used: string | null } | undefined;

  return {
    executionCount: row?.execution_count ?? 0,
    errorCount: row?.error_count ?? 0,
    lastUsed: row?.last_used || undefined,
  };
}

export async function recordToolStats(toolName: string, success: boolean): Promise<void> {
  await initializeDatabase();
  getDb().prepare(`
    INSERT INTO tool_stats (tool_name, execution_count, error_count, last_used)
    VALUES (?, 1, ?, ?)
    ON CONFLICT(tool_name) DO UPDATE SET
      execution_count = execution_count + 1,
      error_count = error_count + excluded.error_count,
      last_used = excluded.last_used
  `).run(toolName, success ? 0 : 1, new Date().toISOString());
}

export async function resetToolStats(toolName: string): Promise<void> {
  await initializeDatabase();
  getDb()
    .prepare('UPDATE tool_stats SET execution_count = 0, error_count = 0, last_used = NULL WHERE tool_name = ?')
    .run(toolName);
}

function mapReminderRow(row: {
  id: string;
  user_id: string;
  channel_id: string;
  guild_id: string | null;
  message_id: string | null;
  text: string;
  due_at: string;
  timezone: string | null;
  status: ReminderStatus;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  error: string | null;
}): ReminderRecord {
  return {
    id: row.id,
    userId: row.user_id,
    channelId: row.channel_id,
    guildId: row.guild_id || undefined,
    messageId: row.message_id || undefined,
    text: row.text,
    dueAt: row.due_at,
    timezone: row.timezone || undefined,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentAt: row.sent_at || undefined,
    error: row.error || undefined,
  };
}

export async function createReminder(input: {
  id: string;
  userId: string;
  channelId: string;
  guildId?: string;
  messageId?: string;
  text: string;
  dueAt: string;
  timezone?: string;
}): Promise<ReminderRecord> {
  await initializeDatabase();

  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO reminders (
      id, user_id, channel_id, guild_id, message_id, text, due_at, timezone, status, created_at, updated_at
    )
    VALUES (@id, @userId, @channelId, @guildId, @messageId, @text, @dueAt, @timezone, 'pending', @now, @now)
  `).run({
    ...input,
    guildId: input.guildId || null,
    messageId: input.messageId || null,
    timezone: input.timezone || null,
    now,
  });

  const reminder = await getReminder(input.id);
  if (!reminder) throw new Error('Falha ao criar lembrete.');
  await notifyReminderStateChanged();
  return reminder;
}

export async function getReminder(id: string): Promise<ReminderRecord | undefined> {
  await initializeDatabase();
  const row = getDb()
    .prepare('SELECT * FROM reminders WHERE id = ?')
    .get(id) as Parameters<typeof mapReminderRow>[0] | undefined;

  return row ? mapReminderRow(row) : undefined;
}

export async function listPendingRemindersForUser(userId: string, limit = 20): Promise<ReminderRecord[]> {
  await initializeDatabase();
  const rows = getDb()
    .prepare(`
      SELECT * FROM reminders
      WHERE user_id = ? AND status = 'pending'
      ORDER BY due_at ASC
      LIMIT ?
    `)
    .all(userId, Math.max(1, Math.min(50, Math.floor(limit)))) as Parameters<typeof mapReminderRow>[0][];

  return rows.map(mapReminderRow);
}

export async function listReminders(options: {
  status?: ReminderStatus;
  limit?: number;
} = {}): Promise<ReminderRecord[]> {
  await initializeDatabase();

  const limit = Math.max(1, Math.min(200, Math.floor(options.limit || 100)));
  const query = options.status
    ? `
      SELECT * FROM reminders
      WHERE status = ?
      ORDER BY
        CASE status WHEN 'pending' THEN 0 WHEN 'failed' THEN 1 WHEN 'sent' THEN 2 ELSE 3 END,
        due_at ASC
      LIMIT ?
    `
    : `
      SELECT * FROM reminders
      ORDER BY
        CASE status WHEN 'pending' THEN 0 WHEN 'failed' THEN 1 WHEN 'sent' THEN 2 ELSE 3 END,
        due_at ASC
      LIMIT ?
    `;

  const rows = options.status
    ? getDb().prepare(query).all(options.status, limit) as Parameters<typeof mapReminderRow>[0][]
    : getDb().prepare(query).all(limit) as Parameters<typeof mapReminderRow>[0][];

  return rows.map(mapReminderRow);
}

export async function getDueReminders(nowIso: string, limit = 25): Promise<ReminderRecord[]> {
  await initializeDatabase();
  const rows = getDb()
    .prepare(`
      SELECT * FROM reminders
      WHERE status = 'pending' AND due_at <= ?
      ORDER BY due_at ASC
      LIMIT ?
    `)
    .all(nowIso, Math.max(1, Math.min(100, Math.floor(limit)))) as Parameters<typeof mapReminderRow>[0][];

  return rows.map(mapReminderRow);
}

export async function getNextPendingReminder(): Promise<ReminderRecord | undefined> {
  await initializeDatabase();
  const row = getDb()
    .prepare(`
      SELECT * FROM reminders
      WHERE status = 'pending'
      ORDER BY due_at ASC
      LIMIT 1
    `)
    .get() as Parameters<typeof mapReminderRow>[0] | undefined;

  return row ? mapReminderRow(row) : undefined;
}

export async function markReminderSent(id: string): Promise<void> {
  await initializeDatabase();
  const now = new Date().toISOString();
  const result = getDb()
    .prepare(`
      UPDATE reminders
      SET status = 'sent', sent_at = ?, updated_at = ?, error = NULL
      WHERE id = ? AND status = 'pending'
    `)
    .run(now, now, id);

  if (result.changes > 0) await notifyReminderStateChanged();
}

export async function markReminderFailed(id: string, error: string): Promise<void> {
  await initializeDatabase();
  const now = new Date().toISOString();
  const result = getDb()
    .prepare(`
      UPDATE reminders
      SET status = 'failed', updated_at = ?, error = ?
      WHERE id = ? AND status = 'pending'
    `)
    .run(now, error.slice(0, 1000), id);

  if (result.changes > 0) await notifyReminderStateChanged();
}

export async function cancelReminder(id: string, userId: string): Promise<ReminderRecord | undefined> {
  await initializeDatabase();
  const reminder = await getReminder(id);

  if (!reminder || reminder.userId !== userId || reminder.status !== 'pending') {
    return undefined;
  }

  const now = new Date().toISOString();
  const result = getDb()
    .prepare(`
      UPDATE reminders
      SET status = 'cancelled', updated_at = ?
      WHERE id = ? AND user_id = ? AND status = 'pending'
    `)
    .run(now, id, userId);

  if (result.changes > 0) await notifyReminderStateChanged();

  return getReminder(id);
}

export async function cancelReminderById(id: string): Promise<ReminderRecord | undefined> {
  await initializeDatabase();
  const reminder = await getReminder(id);

  if (!reminder || reminder.status !== 'pending') {
    return undefined;
  }

  const now = new Date().toISOString();
  const result = getDb()
    .prepare(`
      UPDATE reminders
      SET status = 'cancelled', updated_at = ?
      WHERE id = ? AND status = 'pending'
    `)
    .run(now, id);

  if (result.changes > 0) await notifyReminderStateChanged();

  return getReminder(id);
}
