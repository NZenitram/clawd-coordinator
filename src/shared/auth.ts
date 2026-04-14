import { randomBytes, timingSafeEqual } from 'node:crypto';

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
