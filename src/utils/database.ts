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
