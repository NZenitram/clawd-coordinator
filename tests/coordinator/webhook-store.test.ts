import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryWebhookStore } from '../../src/coordinator/webhook-store.js';

describe('InMemoryWebhookStore', () => {
  let store: InMemoryWebhookStore;

  beforeEach(() => {
    store = new InMemoryWebhookStore();
  });

  describe('create', () => {
    it('creates a webhook with required fields', () => {
      const webhook = store.create({
        name: 'on-push',
        agentName: 'dev-agent',
        promptTemplate: 'Pull {{payload.ref}} and run tests',
      });
      expect(webhook.id).toBeTruthy();
      expect(webhook.name).toBe('on-push');
      expect(webhook.agentName).toBe('dev-agent');
      expect(webhook.promptTemplate).toBe('Pull {{payload.ref}} and run tests');
      expect(webhook.triggerCount).toBe(0);
      expect(webhook.orgId).toBe('__default__');
      expect(webhook.createdAt).toBeGreaterThan(0);
    });

    it('creates a webhook with optional secret', () => {
      const webhook = store.create({
        name: 'secure-hook',
        agentName: 'dev-agent',
        promptTemplate: 'Run build',
        secret: 'mysecret',
      });
      expect(webhook.secret).toBe('mysecret');
    });

    it('creates a webhook with custom orgId', () => {
      const webhook = store.create({
        name: 'org-hook',
        agentName: 'dev-agent',
        promptTemplate: 'Run tests',
        orgId: 'org-abc',
      });
      expect(webhook.orgId).toBe('org-abc');
    });

    it('throws if name already exists', () => {
      store.create({ name: 'dup', agentName: 'agent', promptTemplate: 'hello' });
      expect(() => store.create({ name: 'dup', agentName: 'agent2', promptTemplate: 'world' }))
        .toThrow('already exists');
    });

    it('assigns a unique id per webhook', () => {
      const w1 = store.create({ name: 'hook1', agentName: 'agent', promptTemplate: 'a' });
      const w2 = store.create({ name: 'hook2', agentName: 'agent', promptTemplate: 'b' });
      expect(w1.id).not.toBe(w2.id);
    });
  });

  describe('get', () => {
    it('retrieves by id', () => {
      const created = store.create({ name: 'by-id', agentName: 'agent', promptTemplate: 'x' });
      const found = store.get(created.id);
      expect(found).not.toBeNull();
      expect(found?.name).toBe('by-id');
    });

    it('returns null for unknown id', () => {
      expect(store.get('non-existent-uuid')).toBeNull();
    });
  });

  describe('getByName', () => {
    it('retrieves by name', () => {
      store.create({ name: 'named-hook', agentName: 'agent', promptTemplate: 'x' });
      const found = store.getByName('named-hook');
      expect(found).not.toBeNull();
      expect(found?.name).toBe('named-hook');
    });

    it('returns null for unknown name', () => {
      expect(store.getByName('no-such-hook')).toBeNull();
    });
  });

  describe('list', () => {
    it('returns all webhooks when no orgId filter', () => {
      store.create({ name: 'h1', agentName: 'a', promptTemplate: 'x', orgId: 'org1' });
      store.create({ name: 'h2', agentName: 'a', promptTemplate: 'x', orgId: 'org2' });
      expect(store.list()).toHaveLength(2);
    });

    it('filters by orgId', () => {
      store.create({ name: 'h1', agentName: 'a', promptTemplate: 'x', orgId: 'org1' });
      store.create({ name: 'h2', agentName: 'a', promptTemplate: 'x', orgId: 'org2' });
      const result = store.list('org1');
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('h1');
    });

    it('returns empty array when store is empty', () => {
      expect(store.list()).toHaveLength(0);
    });
  });

  describe('delete', () => {
    it('removes webhook by name', () => {
      store.create({ name: 'to-delete', agentName: 'agent', promptTemplate: 'x' });
      store.delete('to-delete');
      expect(store.getByName('to-delete')).toBeNull();
      expect(store.list()).toHaveLength(0);
    });

    it('silently ignores unknown name', () => {
      expect(() => store.delete('does-not-exist')).not.toThrow();
    });

    it('allows re-creation after deletion', () => {
      store.create({ name: 'recyclable', agentName: 'agent', promptTemplate: 'x' });
      store.delete('recyclable');
      const w2 = store.create({ name: 'recyclable', agentName: 'agent2', promptTemplate: 'y' });
      expect(w2.agentName).toBe('agent2');
    });
  });

  describe('recordTrigger', () => {
    it('increments triggerCount', () => {
      store.create({ name: 'triggered', agentName: 'agent', promptTemplate: 'x' });
      store.recordTrigger('triggered');
      store.recordTrigger('triggered');
      const w = store.getByName('triggered');
      expect(w?.triggerCount).toBe(2);
    });

    it('sets lastTriggeredAt', () => {
      const before = Date.now();
      store.create({ name: 'timed', agentName: 'agent', promptTemplate: 'x' });
      store.recordTrigger('timed');
      const after = Date.now();
      const w = store.getByName('timed');
      expect(w?.lastTriggeredAt).toBeGreaterThanOrEqual(before);
      expect(w?.lastTriggeredAt).toBeLessThanOrEqual(after);
    });

    it('silently ignores unknown name', () => {
      expect(() => store.recordTrigger('no-such-hook')).not.toThrow();
    });
  });
});
