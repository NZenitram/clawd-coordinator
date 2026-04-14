import { describe, it, expect } from 'vitest';
import { generateToken, validateToken, validateAgentToken } from '../../src/shared/auth.js';

describe('auth', () => {
  it('generates a 64-char hex token', () => {
    const token = generateToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('validates correct token', () => {
    const token = generateToken();
    expect(validateToken(token, token)).toBe(true);
  });

  it('rejects wrong token of same length', () => {
    expect(validateToken('a'.repeat(64), 'b'.repeat(64))).toBe(false);
  });

  it('rejects wrong-length token', () => {
    expect(validateToken('short', 'longer-token-here')).toBe(false);
  });

  it('rejects empty token', () => {
    expect(validateToken('', 'abc')).toBe(false);
  });
});

describe('validateAgentToken', () => {
  it('returns agent name for matching token', () => {
    const tokens = { 'agent-1': 'a'.repeat(64), 'agent-2': 'b'.repeat(64) };
    expect(validateAgentToken('a'.repeat(64), tokens)).toBe('agent-1');
    expect(validateAgentToken('b'.repeat(64), tokens)).toBe('agent-2');
  });

  it('returns null for no match', () => {
    const tokens = { 'agent-1': 'a'.repeat(64) };
    expect(validateAgentToken('z'.repeat(64), tokens)).toBeNull();
  });
});
