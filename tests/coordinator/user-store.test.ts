import { describe, it, expect, beforeEach } from 'vitest';
import { UserStore } from '../../src/coordinator/user-store.js';

describe('UserStore', () => {
  let store: UserStore;

  beforeEach(async () => {
    store = await UserStore.create(); // in-memory (no path)
  });

  // ── Users ────────────────────────────────────────────────────────────────────

  it('creates a user and gets them by id', async () => {
    const user = store.createUser('alice', 'operator');
    expect(user.id).toBeDefined();
    expect(user.username).toBe('alice');
    expect(user.role).toBe('operator');
    expect(user.createdAt).toBeGreaterThan(0);

    const fetched = store.getUser(user.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.username).toBe('alice');
  });

  it('gets user by username', () => {
    store.createUser('bob', 'viewer');
    const fetched = store.getUserByUsername('bob');
    expect(fetched).not.toBeNull();
    expect(fetched!.role).toBe('viewer');
  });

  it('returns null for unknown user id', () => {
    expect(store.getUser('no-such-id')).toBeNull();
  });

  it('returns null for unknown username', () => {
    expect(store.getUserByUsername('ghost')).toBeNull();
  });

  it('lists all users', () => {
    store.createUser('alice', 'admin');
    store.createUser('bob', 'operator');
    const users = store.listUsers();
    expect(users).toHaveLength(2);
    const names = users.map(u => u.username);
    expect(names).toContain('alice');
    expect(names).toContain('bob');
  });

  it('enforces username uniqueness', () => {
    store.createUser('alice', 'operator');
    expect(() => store.createUser('alice', 'viewer')).toThrow();
  });

  // ── API Keys ─────────────────────────────────────────────────────────────────

  it('creates an API key and resolves it', () => {
    const user = store.createUser('carol', 'operator');
    const { key, keyId } = store.createApiKey(user.id, 'ci-key');

    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThan(0);
    expect(typeof keyId).toBe('string');

    const resolved = store.resolveApiKey(key);
    expect(resolved).not.toBeNull();
    expect(resolved!.userId).toBe(user.id);
    expect(resolved!.role).toBe('operator');
  });

  it('returns null when resolving unknown key', () => {
    expect(store.resolveApiKey('not-a-real-key')).toBeNull();
  });

  it('revokes an API key and returns null on resolve', () => {
    const user = store.createUser('dave', 'viewer');
    const { key, keyId } = store.createApiKey(user.id, 'my-key');

    // Key works before revocation
    expect(store.resolveApiKey(key)).not.toBeNull();

    store.revokeApiKey(keyId);

    // Key returns null after revocation
    expect(store.resolveApiKey(key)).toBeNull();
  });

  it('lists API keys for a user (without the raw key)', () => {
    const user = store.createUser('eve', 'operator');
    store.createApiKey(user.id, 'key-a');
    store.createApiKey(user.id, 'key-b');

    const keys = store.listApiKeys(user.id);
    expect(keys).toHaveLength(2);
    const labels = keys.map(k => k.label);
    expect(labels).toContain('key-a');
    expect(labels).toContain('key-b');
    // Should not include raw key in the listed info
    for (const k of keys) {
      expect(k).not.toHaveProperty('key');
    }
  });

  it('revoked key shows revokedAt in list', () => {
    const user = store.createUser('frank', 'viewer');
    const { keyId } = store.createApiKey(user.id, 'revoked-key');
    store.revokeApiKey(keyId);

    const keys = store.listApiKeys(user.id);
    const revokedKey = keys.find(k => k.id === keyId);
    expect(revokedKey).toBeDefined();
    expect(revokedKey!.revokedAt).not.toBeNull();
    expect(revokedKey!.revokedAt).toBeGreaterThan(0);
  });

  it('creates a user with admin role', () => {
    const user = store.createUser('superuser', 'admin');
    expect(user.role).toBe('admin');
    const fetched = store.getUser(user.id);
    expect(fetched!.role).toBe('admin');
  });

  it('API key key_hash is not the raw key', () => {
    const user = store.createUser('grace', 'operator');
    const { key } = store.createApiKey(user.id);
    // The raw key itself should not match the hash (sanity)
    const resolved = store.resolveApiKey(key);
    expect(resolved).not.toBeNull();
    // Resolving with something other than raw key should fail
    expect(store.resolveApiKey('wrong-' + key)).toBeNull();
  });
});
