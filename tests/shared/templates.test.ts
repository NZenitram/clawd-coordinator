import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Use a temp directory as the home so file operations stay isolated
let tmpHome: string;

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return {
    ...actual,
    homedir: () => tmpHome,
  };
});

// Import after mock is in place
import {
  getTemplatesDir,
  loadTemplate,
  listTemplates,
  saveTemplate,
  deleteTemplate,
  substituteVariables,
  parseVars,
  validateVariables,
  resolveVariables,
  type TaskTemplate,
} from '../../src/shared/templates.js';

describe('substituteVariables', () => {
  it('replaces {{vars}} with provided values', () => {
    expect(substituteVariables('Hello {{name}}!', { name: 'world' })).toBe('Hello world!');
  });

  it('replaces multiple occurrences of the same var', () => {
    expect(substituteVariables('{{a}} and {{a}}', { a: 'x' })).toBe('x and x');
  });

  it('replaces multiple distinct vars', () => {
    expect(substituteVariables('{{pkg}} at {{version}}', { pkg: 'lodash', version: '4.17.21' })).toBe(
      'lodash at 4.17.21'
    );
  });

  it('leaves unknown {{vars}} as-is', () => {
    expect(substituteVariables('Hello {{unknown}}', { name: 'world' })).toBe('Hello {{unknown}}');
  });

  it('handles empty vars map', () => {
    expect(substituteVariables('no vars here', {})).toBe('no vars here');
  });

  it('handles text with no placeholders', () => {
    expect(substituteVariables('plain text', { foo: 'bar' })).toBe('plain text');
  });
});

describe('parseVars', () => {
  it('parses a single key=value pair', () => {
    expect(parseVars('key=val')).toEqual({ key: 'val' });
  });

  it('parses comma-separated key=value pairs', () => {
    expect(parseVars('a=1,b=2,c=three')).toEqual({ a: '1', b: '2', c: 'three' });
  });

  it('handles values that contain equals signs', () => {
    expect(parseVars('url=http://example.com?x=1')).toEqual({ url: 'http://example.com?x=1' });
  });

  it('skips entries without an equals sign', () => {
    expect(parseVars('key=val,noequalssign,other=ok')).toEqual({ key: 'val', other: 'ok' });
  });

  it('returns empty object for empty string', () => {
    expect(parseVars('')).toEqual({});
  });

  it('trims whitespace from keys and values', () => {
    expect(parseVars(' key = val ')).toEqual({ key: 'val' });
  });
});

describe('validateVariables', () => {
  it('returns empty array when all required vars are provided', () => {
    const tmpl: TaskTemplate = {
      name: 'test',
      prompt: '{{pkg}}',
      variables: { pkg: { required: true } },
    };
    expect(validateVariables(tmpl, { pkg: 'lodash' })).toEqual([]);
  });

  it('catches missing required vars', () => {
    const tmpl: TaskTemplate = {
      name: 'test',
      prompt: '{{pkg}} {{version}}',
      variables: {
        pkg: { required: true },
        version: { required: true },
      },
    };
    expect(validateVariables(tmpl, { pkg: 'lodash' })).toEqual(['version']);
  });

  it('does not flag optional vars (required: false) as missing', () => {
    const tmpl: TaskTemplate = {
      name: 'test',
      prompt: '{{label}}',
      variables: { label: { required: false } },
    };
    expect(validateVariables(tmpl, {})).toEqual([]);
  });

  it('does not flag vars that have defaults as missing', () => {
    const tmpl: TaskTemplate = {
      name: 'test',
      prompt: '{{version}}',
      variables: { version: { required: true, default: 'latest' } },
    };
    expect(validateVariables(tmpl, {})).toEqual([]);
  });

  it('returns empty array when template has no variables', () => {
    const tmpl: TaskTemplate = { name: 'test', prompt: 'plain' };
    expect(validateVariables(tmpl, {})).toEqual([]);
  });
});

describe('resolveVariables', () => {
  it('fills in defaults for variables not supplied by caller', () => {
    const tmpl: TaskTemplate = {
      name: 'test',
      prompt: '{{version}}',
      variables: { version: { required: true, default: 'latest' } },
    };
    expect(resolveVariables(tmpl, {})).toEqual({ version: 'latest' });
  });

  it('prefers caller-supplied value over default', () => {
    const tmpl: TaskTemplate = {
      name: 'test',
      prompt: '{{version}}',
      variables: { version: { default: 'latest' } },
    };
    expect(resolveVariables(tmpl, { version: '2.0.0' })).toEqual({ version: '2.0.0' });
  });

  it('passes through caller vars when no template variables defined', () => {
    const tmpl: TaskTemplate = { name: 'test', prompt: 'plain' };
    expect(resolveVariables(tmpl, { foo: 'bar' })).toEqual({ foo: 'bar' });
  });
});

describe('loadTemplate / saveTemplate / listTemplates / deleteTemplate', () => {
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('getTemplatesDir returns path inside the (mocked) home dir', () => {
    expect(getTemplatesDir()).toBe(path.join(tmpHome, '.coord', 'templates'));
  });

  it('saveTemplate and loadTemplate round-trip correctly', () => {
    const tmpl: TaskTemplate = {
      name: 'upgrade-package',
      description: 'Upgrade a package',
      prompt: 'Upgrade {{package}} to {{version}}',
      on: 'ops-agent',
      budget: '1.50',
      variables: {
        package: { required: true },
        version: { required: true, default: 'latest' },
      },
    };
    saveTemplate(tmpl);
    const loaded = loadTemplate('upgrade-package');
    expect(loaded).toEqual(tmpl);
  });

  it('loadTemplate returns null for a non-existent template', () => {
    expect(loadTemplate('does-not-exist')).toBeNull();
  });

  it('listTemplates returns saved templates', () => {
    const t1: TaskTemplate = { name: 'alpha', prompt: 'do alpha' };
    const t2: TaskTemplate = { name: 'beta', prompt: 'do beta', description: 'Beta task' };
    saveTemplate(t1);
    saveTemplate(t2);
    const list = listTemplates();
    const names = list.map((t) => t.name).sort();
    expect(names).toEqual(['alpha', 'beta']);
  });

  it('listTemplates returns empty array when no templates exist', () => {
    expect(listTemplates()).toEqual([]);
  });

  it('deleteTemplate removes the file', () => {
    const tmpl: TaskTemplate = { name: 'to-delete', prompt: 'delete me' };
    saveTemplate(tmpl);
    expect(loadTemplate('to-delete')).not.toBeNull();
    deleteTemplate('to-delete');
    expect(loadTemplate('to-delete')).toBeNull();
  });

  it('deleteTemplate throws when template does not exist', () => {
    expect(() => deleteTemplate('ghost')).toThrow('Template "ghost" not found');
  });
});
