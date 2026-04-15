import initSqlJs, { type Database } from 'sql.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID, createHash, randomBytes } from 'node:crypto';

export type UserRole = 'admin' | 'operator' | 'viewer';

export interface User {
  id: string;
  username: string;
  role: UserRole;
  createdAt: number;
}

export interface ApiKeyInfo {
  id: string;
  userId: string;
  label: string | null;
  createdAt: number;
  revokedAt: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL DEFAULT 'operator',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  key_hash TEXT NOT NULL,
  label TEXT,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
`;

export class UserStore {
  private db: Database;
  private dbPath: string | null;

  private constructor(db: Database, dbPath: string | null) {
    this.db = db;
    this.dbPath = dbPath;
    this.db.run(SCHEMA);
  }

  static async create(dbPath?: string): Promise<UserStore> {
    const SQL = await initSqlJs();
    const resolvedPath = dbPath ?? null;
    let db: Database;
    if (resolvedPath && existsSync(resolvedPath)) {
      const buffer = readFileSync(resolvedPath);
      db = new SQL.Database(buffer);
    } else {
      db = new SQL.Database();
    }
    return new UserStore(db, resolvedPath);
  }

  private save(): void {
    if (this.dbPath) {
      const data = this.db.export();
      writeFileSync(this.dbPath, Buffer.from(data));
    }
  }

  createUser(username: string, role: UserRole): User {
    const id = randomUUID();
    const now = Date.now();
    this.db.run(
      'INSERT INTO users (id, username, role, created_at) VALUES (?, ?, ?, ?)',
      [id, username, role, now]
    );
    this.save();
    return { id, username, role, createdAt: now };
  }

  getUser(id: string): User | null {
    const stmt = this.db.prepare('SELECT * FROM users WHERE id = ?');
    stmt.bind([id]);
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const row = stmt.getAsObject();
    stmt.free();
    return this.rowToUser(row);
  }

  getUserByUsername(username: string): User | null {
    const stmt = this.db.prepare('SELECT * FROM users WHERE username = ?');
    stmt.bind([username]);
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const row = stmt.getAsObject();
    stmt.free();
    return this.rowToUser(row);
  }

  listUsers(): User[] {
    const stmt = this.db.prepare('SELECT * FROM users ORDER BY created_at ASC');
    const results: User[] = [];
    while (stmt.step()) {
      results.push(this.rowToUser(stmt.getAsObject()));
    }
    stmt.free();
    return results;
  }

  createApiKey(userId: string, label?: string): { key: string; keyId: string } {
    const rawKey = randomBytes(32).toString('hex');
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    const keyId = randomUUID();
    const now = Date.now();
    this.db.run(
      'INSERT INTO api_keys (id, user_id, key_hash, label, created_at) VALUES (?, ?, ?, ?, ?)',
      [keyId, userId, keyHash, label ?? null, now]
    );
    this.save();
    return { key: rawKey, keyId };
  }

  resolveApiKey(rawKey: string): { userId: string; role: string } | null {
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    const stmt = this.db.prepare(
      `SELECT ak.user_id, u.role
       FROM api_keys ak
       JOIN users u ON u.id = ak.user_id
       WHERE ak.key_hash = ? AND ak.revoked_at IS NULL`
    );
    stmt.bind([keyHash]);
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const row = stmt.getAsObject();
    stmt.free();
    return { userId: row.user_id as string, role: row.role as string };
  }

  revokeApiKey(keyId: string): void {
    this.db.run('UPDATE api_keys SET revoked_at = ? WHERE id = ?', [Date.now(), keyId]);
    this.save();
  }

  listApiKeys(userId: string): ApiKeyInfo[] {
    const stmt = this.db.prepare(
      'SELECT id, user_id, label, created_at, revoked_at FROM api_keys WHERE user_id = ? ORDER BY created_at ASC'
    );
    stmt.bind([userId]);
    const results: ApiKeyInfo[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      results.push({
        id: row.id as string,
        userId: row.user_id as string,
        label: (row.label as string | null) ?? null,
        createdAt: row.created_at as number,
        revokedAt: (row.revoked_at as number | null) ?? null,
      });
    }
    stmt.free();
    return results;
  }

  close(): void {
    this.save();
    this.db.close();
  }

  private rowToUser(row: Record<string, unknown>): User {
    return {
      id: row.id as string,
      username: row.username as string,
      role: row.role as UserRole,
      createdAt: row.created_at as number,
    };
  }
}
