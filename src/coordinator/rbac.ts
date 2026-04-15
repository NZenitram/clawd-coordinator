import type { UserRole } from './user-store.js';

const PERMISSIONS: Record<UserRole, Set<string>> = {
  admin: new Set(['*']),
  operator: new Set([
    'dispatch-task',
    'list-tasks',
    'get-task',
    'subscribe-task',
    'list-agents',
    'get-agent',
    'list-sessions',
    'send-message',
  ]),
  viewer: new Set([
    'list-tasks',
    'get-task',
    'list-agents',
    'get-agent',
  ]),
};

export function checkPermission(role: UserRole, action: string): boolean {
  const allowed = PERMISSIONS[role];
  return allowed.has('*') || allowed.has(action);
}
