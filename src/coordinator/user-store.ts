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

export interface Org {
  id: string;
  name: string;
  createdAt: number;
}

export interface OrgMembership {
  orgId: string;
  role: string;
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

CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS org_members (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'operator',
  PRIMARY KEY (org_id, user_id)
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

  // ── Orgs ─────────────────────────────────────────────────────────────────────

  createOrg(name: string): Org {
    const id = randomUUID();
    const now = Date.now();
    this.db.run(
      'INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)',
      [id, name, now]
    );
    this.save();
    return { id, name, createdAt: now };
  }

  getOrg(id: string): Org | null {
    const stmt = this.db.prepare('SELECT * FROM orgs WHERE id = ?');
    stmt.bind([id]);
    if (!stmt.step()) { stmt.free(); return null; }
    const row = stmt.getAsObject();
    stmt.free();
    return this.rowToOrg(row);
  }

  getOrgByName(name: string): Org | null {
    const stmt = this.db.prepare('SELECT * FROM orgs WHERE name = ?');
    stmt.bind([name]);
    if (!stmt.step()) { stmt.free(); return null; }
    const row = stmt.getAsObject();
    stmt.free();
    return this.rowToOrg(row);
  }

  listOrgs(): Org[] {
    const stmt = this.db.prepare('SELECT * FROM orgs ORDER BY created_at ASC');
    const results: Org[] = [];
    while (stmt.step()) {
      results.push(this.rowToOrg(stmt.getAsObject()));
    }
    stmt.free();
    return results;
  }

  addOrgMember(orgId: string, userId: string, role: string): void {
    this.db.run(
      'INSERT OR REPLACE INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)',
      [orgId, userId, role]
    );
    this.save();
  }

  removeOrgMember(orgId: string, userId: string): void {
    this.db.run('DELETE FROM org_members WHERE org_id = ? AND user_id = ?', [orgId, userId]);
    this.save();
  }

  getOrgMembership(userId: string): OrgMembership[] {
    const stmt = this.db.prepare('SELECT org_id, role FROM org_members WHERE user_id = ? ORDER BY org_id ASC');
    stmt.bind([userId]);
    const results: OrgMembership[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      results.push({ orgId: row.org_id as string, role: row.role as string });
    }
    stmt.free();
    return results;
  }

  getUserOrg(userId: string, orgId: string): OrgMembership | null {
    const stmt = this.db.prepare('SELECT org_id, role FROM org_members WHERE user_id = ? AND org_id = ?');
    stmt.bind([userId, orgId]);
    if (!stmt.step()) { stmt.free(); return null; }
    const row = stmt.getAsObject();
    stmt.free();
    return { orgId: row.org_id as string, role: row.role as string };
  }

  listOrgMembers(orgId: string): Array<{ userId: string; role: string }> {
    const stmt = this.db.prepare('SELECT user_id, role FROM org_members WHERE org_id = ? ORDER BY user_id ASC');
    stmt.bind([orgId]);
    const results: Array<{ userId: string; role: string }> = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      results.push({ userId: row.user_id as string, role: row.role as string });
    }
    stmt.free();
    return results;
  }

  close(): void {
    this.save();
    this.db.close();
  }

  private rowToOrg(row: Record<string, unknown>): Org {
    return {
      id: row.id as string,
      name: row.name as string,
      createdAt: row.created_at as number,
    };
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
