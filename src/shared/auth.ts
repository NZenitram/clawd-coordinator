import { randomBytes, timingSafeEqual } from 'node:crypto';

export function validateAgentToken(provided: string, agentTokens: Record<string, string>): string | null {
  for (const [name, token] of Object.entries(agentTokens)) {
    if (validateToken(provided, token)) return name;
  }
  return null;
}

export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

export function validateToken(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Consume constant time even on length mismatch
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}
