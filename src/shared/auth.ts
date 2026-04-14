import { randomBytes } from 'node:crypto';

export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

export function validateToken(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < provided.length; i++) {
    result |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return result === 0;
}
