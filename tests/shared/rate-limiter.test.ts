import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from '../../src/shared/rate-limiter.js';

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows consumption up to maxTokens immediately', () => {
    const limiter = new RateLimiter(5, 1000);
    for (let i = 0; i < 5; i++) {
      expect(limiter.tryConsume()).toBe(true);
    }
  });

  it('rejects consumption once all tokens are exhausted', () => {
    const limiter = new RateLimiter(3, 1000);
    limiter.tryConsume();
    limiter.tryConsume();
    limiter.tryConsume();
    expect(limiter.tryConsume()).toBe(false);
  });

  it('refills tokens after the refill interval elapses', () => {
    const limiter = new RateLimiter(5, 1000);
    // Exhaust all tokens
    for (let i = 0; i < 5; i++) limiter.tryConsume();
    expect(limiter.tryConsume()).toBe(false);

    // Advance time by one full interval — should refill all 5 tokens
    vi.advanceTimersByTime(1000);
    expect(limiter.tryConsume()).toBe(true);
  });

  it('does not exceed maxTokens after multiple intervals', () => {
    const limiter = new RateLimiter(5, 1000);
    // Advance 10 seconds without consuming anything
    vi.advanceTimersByTime(10000);
    // Should still cap at maxTokens (5)
    for (let i = 0; i < 5; i++) {
      expect(limiter.tryConsume()).toBe(true);
    }
    expect(limiter.tryConsume()).toBe(false);
  });

  it('refills proportionally for a partial interval', () => {
    // maxTokens=10, refillIntervalMs=1000 → 10 tokens per second
    const limiter = new RateLimiter(10, 1000);
    // Exhaust all tokens
    for (let i = 0; i < 10; i++) limiter.tryConsume();
    expect(limiter.tryConsume()).toBe(false);

    // Advance half the interval → Math.floor(0.5 * 10) = 5 tokens added
    vi.advanceTimersByTime(500);
    for (let i = 0; i < 5; i++) {
      expect(limiter.tryConsume()).toBe(true);
    }
    expect(limiter.tryConsume()).toBe(false);
  });

  it('works with a maxTokens of 1 (strict single-request gate)', () => {
    const limiter = new RateLimiter(1, 500);
    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(false);

    vi.advanceTimersByTime(500);
    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(false);
  });

  it('does not refill when elapsed time is less than one token worth', () => {
    // maxTokens=100, refillIntervalMs=1000 → 1 token per 10ms
    // Advance only 5ms → Math.floor(0.005 * 100) = 0 tokens added
    const limiter = new RateLimiter(100, 1000);
    for (let i = 0; i < 100; i++) limiter.tryConsume();
    expect(limiter.tryConsume()).toBe(false);

    vi.advanceTimersByTime(5);
    expect(limiter.tryConsume()).toBe(false);

    vi.advanceTimersByTime(5); // now 10ms elapsed → 1 token
    expect(limiter.tryConsume()).toBe(true);
  });
});
