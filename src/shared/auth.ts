import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';

const COMPARE_KEY = 'coord-token-compare';

export function validateAgentToken(provided: string, agentTokens: Record<string, string>): string | null {
  let matchedName: string | null = null;
  for (const [name, token] of Object.entries(agentTokens)) {
    if (validateToken(provided, token)) {
      matchedName = name;
    }
  }
  return matchedName;
}

export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

export function validateToken(provided: string, expected: string): boolean {
  const a = createHmac('sha256', COMPARE_KEY).update(provided).digest();
  const b = createHmac('sha256', COMPARE_KEY).update(expected).digest();
  return timingSafeEqual(a, b);
}
