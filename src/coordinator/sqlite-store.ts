import initSqlJs, { type Database } from 'sql.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Task, TaskStatus, TaskStore } from './tasks.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  session_id TEXT,
  trace_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  truncated INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS task_output (
  task_id TEXT NOT NULL,
  line_num INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (task_id, line_num),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);
`;

export class SqliteTaskStore implements TaskStore {
  private db: Database;
  private dbPath: string | null;
  private maxOutputLines: number;

  private constructor(db: Database, dbPath: string | null, maxOutputLines: number) {
    this.db = db;
    this.dbPath = dbPath;
    this.maxOutputLines = maxOutputLines;
    this.db.run(SCHEMA);
  }

  static async create(options?: { dbPath?: string; maxOutputLines?: number }): Promise<SqliteTaskStore> {
    const SQL = await initSqlJs();
    const dbPath = options?.dbPath ?? null;
    let db: Database;
    if (dbPath && existsSync(dbPath)) {
      const buffer = readFileSync(dbPath);
      db = new SQL.Database(buffer);
    } else {
      db = new SQL.Database();
    }
    return new SqliteTaskStore(db, dbPath, options?.maxOutputLines ?? 10000);
  }

  private save(): void {
    if (this.dbPath) {
      const data = this.db.export();
      writeFileSync(this.dbPath, Buffer.from(data));
    }
  }

  create(params: { agentName: string; prompt: string; sessionId?: string; traceId?: string }): Task {
    const id = randomUUID();
    const now = Date.now();
    this.db.run(
      'INSERT INTO tasks (id, agent_name, prompt, session_id, trace_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, params.agentName, params.prompt, params.sessionId ?? null, params.traceId ?? null, 'pending', now]
    );
    this.save();
    return {
      id,
      agentName: params.agentName,
      prompt: params.prompt,
      sessionId: params.sessionId,
      traceId: params.traceId,
      status: 'pending',
      output: [],
      truncated: false,
      createdAt: now,
    };
  }

  get(id: string): Task | null {
    const stmt = this.db.prepare('SELECT * FROM tasks WHERE id = ?');
    stmt.bind([id]);
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const row = stmt.getAsObject();
    stmt.free();

    const output = this.getOutput(id);
    return this.rowToTask(row, output);
  }

  list(status?: TaskStatus): Task[] {
    let sql = 'SELECT * FROM tasks';
    const params: string[] = [];
    if (status) {
      sql += ' WHERE status = ?';
      params.push(status);
    }
    sql += ' ORDER BY created_at ASC';

    const results: Task[] = [];
    const stmt = this.db.prepare(sql);
    if (params.length) stmt.bind(params);
    while (stmt.step()) {
      const row = stmt.getAsObject();
      const output = this.getOutput(row.id as string);
      results.push(this.rowToTask(row, output));
    }
    stmt.free();
    return results;
  }

  setRunning(id: string): void {
    this.db.run('UPDATE tasks SET status = ? WHERE id = ?', ['running', id]);
    this.save();
  }

  appendOutput(id: string, data: string): boolean {
    const stmt = this.db.prepare('SELECT truncated FROM tasks WHERE id = ?');
    stmt.bind([id]);
    if (!stmt.step()) { stmt.free(); return false; }
    const truncated = stmt.getAsObject().truncated as number;
    stmt.free();
    if (truncated) return false;

    const countStmt = this.db.prepare('SELECT COUNT(*) as cnt FROM task_output WHERE task_id = ?');
    countStmt.bind([id]);
    countStmt.step();
    const count = countStmt.getAsObject().cnt as number;
    countStmt.free();

    if (count >= this.maxOutputLines) {
      this.db.run('UPDATE tasks SET truncated = 1 WHERE id = ?', [id]);
      this.db.run(
        'INSERT INTO task_output (task_id, line_num, data) VALUES (?, ?, ?)',
        [id, count, `[OUTPUT TRUNCATED at ${this.maxOutputLines} lines]`]
      );
      this.save();
      return false;
    }

    this.db.run(
      'INSERT INTO task_output (task_id, line_num, data) VALUES (?, ?, ?)',
      [id, count, data]
    );
    this.save();
    return true;
  }

  setCompleted(id: string): void {
    this.db.run('UPDATE tasks SET status = ?, completed_at = ? WHERE id = ?', ['completed', Date.now(), id]);
    this.save();
  }

  setError(id: string, error: string): void {
    this.db.run('UPDATE tasks SET status = ?, error = ?, completed_at = ? WHERE id = ?', ['error', error, Date.now(), id]);
    this.save();
  }

  cleanup(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    // Get task IDs to delete
    const stmt = this.db.prepare(
      'SELECT id FROM tasks WHERE (status = ? OR status = ?) AND completed_at IS NOT NULL AND completed_at < ?'
    );
    stmt.bind(['completed', 'error', cutoff]);
    const ids: string[] = [];
    while (stmt.step()) {
      ids.push(stmt.getAsObject().id as string);
    }
    stmt.free();

    for (const id of ids) {
      this.db.run('DELETE FROM task_output WHERE task_id = ?', [id]);
      this.db.run('DELETE FROM tasks WHERE id = ?', [id]);
    }
    if (ids.length > 0) this.save();
    return ids.length;
  }

  /** Mark any stale running tasks as error on startup recovery */
  recoverStaleTasks(): number {
    const result = this.db.run(
      'UPDATE tasks SET status = ?, error = ?, completed_at = ? WHERE status = ?',
      ['error', 'Coordinator restarted while task was running', Date.now(), 'running']
    );
    this.save();
    return this.db.getRowsModified();
  }

  close(): void {
    this.save();
    this.db.close();
  }

  private getOutput(taskId: string): string[] {
    const stmt = this.db.prepare('SELECT data FROM task_output WHERE task_id = ? ORDER BY line_num ASC');
    stmt.bind([taskId]);
    const output: string[] = [];
    while (stmt.step()) {
      output.push(stmt.getAsObject().data as string);
    }
    stmt.free();
    return output;
  }

  private rowToTask(row: Record<string, unknown>, output: string[]): Task {
    return {
      id: row.id as string,
      agentName: row.agent_name as string,
      prompt: row.prompt as string,
      sessionId: (row.session_id as string) ?? undefined,
      traceId: (row.trace_id as string) ?? undefined,
      status: row.status as TaskStatus,
      error: (row.error as string) ?? undefined,
      output,
      truncated: (row.truncated as number) === 1,
      createdAt: row.created_at as number,
      completedAt: (row.completed_at as number) ?? undefined,
    };
  }
}
