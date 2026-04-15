import { describe, it, expect } from 'vitest';
import { resolveTemplate } from '../../src/coordinator/webhook-template.js';

describe('resolveTemplate', () => {
  describe('simple field access', () => {
    it('resolves a top-level field', () => {
      const result = resolveTemplate('Branch: {{payload.ref}}', { payload: { ref: 'main' } });
      expect(result).toBe('Branch: main');
    });

    it('resolves multiple placeholders', () => {
      const result = resolveTemplate('{{payload.repo}} on {{payload.ref}}', {
        payload: { repo: 'my-repo', ref: 'develop' },
      });
      expect(result).toBe('my-repo on develop');
    });

    it('resolves nested paths', () => {
      const result = resolveTemplate('Author: {{payload.pusher.name}}', {
        payload: { pusher: { name: 'Alice' } },
      });
      expect(result).toBe('Author: Alice');
    });

    it('resolves deeply nested paths', () => {
      const result = resolveTemplate('{{payload.a.b.c.d}}', {
        payload: { a: { b: { c: { d: 'deep' } } } },
      });
      expect(result).toBe('deep');
    });
  });

  describe('array index access', () => {
    it('resolves array index with bracket notation', () => {
      const result = resolveTemplate('First commit: {{payload.commits[0].message}}', {
        payload: { commits: [{ message: 'initial commit' }, { message: 'second commit' }] },
      });
      expect(result).toBe('First commit: initial commit');
    });

    it('resolves second array element', () => {
      const result = resolveTemplate('Second: {{payload.items[1]}}', {
        payload: { items: ['a', 'b', 'c'] },
      });
      expect(result).toBe('Second: b');
    });

    it('resolves nested field after array index', () => {
      const result = resolveTemplate('{{payload.commits[0].author.name}}', {
        payload: {
          commits: [{ author: { name: 'Bob' } }],
        },
      });
      expect(result).toBe('Bob');
    });

    it('returns empty string for out-of-bounds array index', () => {
      const result = resolveTemplate('{{payload.items[5]}}', {
        payload: { items: ['a', 'b'] },
      });
      expect(result).toBe('');
    });
  });

  describe('missing paths', () => {
    it('returns empty string for missing top-level field', () => {
      const result = resolveTemplate('{{payload.missing}}', { payload: {} });
      expect(result).toBe('');
    });

    it('returns empty string for missing nested field', () => {
      const result = resolveTemplate('{{payload.a.b.c}}', { payload: { a: {} } });
      expect(result).toBe('');
    });

    it('returns empty string for null payload', () => {
      const result = resolveTemplate('{{payload.ref}}', null);
      expect(result).toBe('');
    });

    it('returns empty string for undefined payload', () => {
      const result = resolveTemplate('{{payload.ref}}', undefined);
      expect(result).toBe('');
    });

    it('handles missing intermediate node without throwing', () => {
      const result = resolveTemplate('{{payload.x.y.z}}', { payload: {} });
      expect(result).toBe('');
    });
  });

  describe('type coercion', () => {
    it('converts number to string', () => {
      const result = resolveTemplate('Count: {{payload.count}}', { payload: { count: 42 } });
      expect(result).toBe('Count: 42');
    });

    it('converts boolean to string', () => {
      const result = resolveTemplate('{{payload.active}}', { payload: { active: true } });
      expect(result).toBe('true');
    });
  });

  describe('template with no placeholders', () => {
    it('returns template unchanged', () => {
      const result = resolveTemplate('Run all tests', { payload: { ref: 'main' } });
      expect(result).toBe('Run all tests');
    });
  });

  describe('whitespace in placeholder', () => {
    it('trims whitespace around path', () => {
      const result = resolveTemplate('{{ payload.ref }}', { payload: { ref: 'trimmed' } });
      expect(result).toBe('trimmed');
    });
  });
});
