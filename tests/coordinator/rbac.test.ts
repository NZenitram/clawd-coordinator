import { describe, it, expect } from 'vitest';
import { checkPermission } from '../../src/coordinator/rbac.js';

describe('RBAC', () => {
  describe('admin', () => {
    it('can perform any action', () => {
      expect(checkPermission('admin', 'dispatch-task')).toBe(true);
      expect(checkPermission('admin', 'list-tasks')).toBe(true);
      expect(checkPermission('admin', 'get-task')).toBe(true);
      expect(checkPermission('admin', 'subscribe-task')).toBe(true);
      expect(checkPermission('admin', 'list-agents')).toBe(true);
      expect(checkPermission('admin', 'get-agent')).toBe(true);
      expect(checkPermission('admin', 'list-sessions')).toBe(true);
    });

    it('can perform arbitrary unknown actions (wildcard)', () => {
      expect(checkPermission('admin', 'some-future-action')).toBe(true);
      expect(checkPermission('admin', 'manage-users')).toBe(true);
    });
  });

  describe('operator', () => {
    it('can dispatch tasks', () => {
      expect(checkPermission('operator', 'dispatch-task')).toBe(true);
    });

    it('can list and get tasks', () => {
      expect(checkPermission('operator', 'list-tasks')).toBe(true);
      expect(checkPermission('operator', 'get-task')).toBe(true);
    });

    it('can subscribe to tasks', () => {
      expect(checkPermission('operator', 'subscribe-task')).toBe(true);
    });

    it('can list and get agents', () => {
      expect(checkPermission('operator', 'list-agents')).toBe(true);
      expect(checkPermission('operator', 'get-agent')).toBe(true);
    });

    it('can list sessions', () => {
      expect(checkPermission('operator', 'list-sessions')).toBe(true);
    });

    it('cannot perform unknown/privileged actions', () => {
      expect(checkPermission('operator', 'manage-users')).toBe(false);
      expect(checkPermission('operator', 'some-future-action')).toBe(false);
    });
  });

  describe('viewer', () => {
    it('can list and get tasks', () => {
      expect(checkPermission('viewer', 'list-tasks')).toBe(true);
      expect(checkPermission('viewer', 'get-task')).toBe(true);
    });

    it('can list and get agents', () => {
      expect(checkPermission('viewer', 'list-agents')).toBe(true);
      expect(checkPermission('viewer', 'get-agent')).toBe(true);
    });

    it('cannot dispatch tasks', () => {
      expect(checkPermission('viewer', 'dispatch-task')).toBe(false);
    });

    it('cannot subscribe to tasks', () => {
      expect(checkPermission('viewer', 'subscribe-task')).toBe(false);
    });

    it('cannot list sessions', () => {
      expect(checkPermission('viewer', 'list-sessions')).toBe(false);
    });

    it('cannot perform unknown/privileged actions', () => {
      expect(checkPermission('viewer', 'manage-users')).toBe(false);
    });
  });
});
