import { describe, it, expect } from 'vitest';
import { getDescriptionMarkdown, getDescriptionJson } from '../../src/cli/commands/describe.js';
import type { DescriptionSchema } from '../../src/cli/commands/describe.js';

describe('coord describe — markdown output', () => {
  it('contains a commands section', () => {
    const md = getDescriptionMarkdown();
    expect(md).toContain('## CLI Commands');
  });

  it('contains a REST API section', () => {
    const md = getDescriptionMarkdown();
    expect(md).toContain('## REST API');
  });

  it('contains an MCP tools section', () => {
    const md = getDescriptionMarkdown();
    expect(md).toContain('## MCP Tools');
  });

  it('mentions key commands', () => {
    const md = getDescriptionMarkdown();
    expect(md).toContain('coord run');
    expect(md).toContain('coord agent');
    expect(md).toContain('coord serve');
    expect(md).toContain('coord fan-out');
    expect(md).toContain('coord push');
    expect(md).toContain('coord pull');
    expect(md).toContain('coord transfer');
  });

  it('mentions the permission model', () => {
    const md = getDescriptionMarkdown();
    expect(md).toContain('--dangerously-skip-permissions');
    expect(md).toContain('--allowed-tools');
    expect(md).toContain('--permission-mode');
  });

  it('contains usage examples section', () => {
    const md = getDescriptionMarkdown();
    expect(md).toContain('Common Usage Patterns');
  });

  it('includes REST endpoints with methods', () => {
    const md = getDescriptionMarkdown();
    expect(md).toContain('GET');
    expect(md).toContain('POST');
    expect(md).toContain('/api/agents');
    expect(md).toContain('/api/dispatch');
  });

  it('includes MCP tool names', () => {
    const md = getDescriptionMarkdown();
    expect(md).toContain('dispatch_task');
    expect(md).toContain('list_agents');
    expect(md).toContain('get_task_result');
  });

  it('mentions file transfer capabilities', () => {
    const md = getDescriptionMarkdown();
    expect(md).toContain('File Transfer');
  });
});

describe('coord describe --json output', () => {
  let schema: DescriptionSchema;

  beforeAll(() => {
    schema = getDescriptionJson();
  });

  it('parses as valid JSON with expected top-level keys', () => {
    const json = JSON.stringify(schema);
    const parsed = JSON.parse(json) as DescriptionSchema;
    expect(parsed).toHaveProperty('name', 'clawd-coordinator');
    expect(parsed).toHaveProperty('version', '0.1.0');
    expect(parsed).toHaveProperty('description');
    expect(parsed).toHaveProperty('commands');
    expect(parsed).toHaveProperty('restApi');
    expect(parsed).toHaveProperty('mcpTools');
  });

  it('commands array is non-empty', () => {
    expect(schema.commands.length).toBeGreaterThan(0);
  });

  it('restApi array is non-empty', () => {
    expect(schema.restApi.length).toBeGreaterThan(0);
  });

  it('mcpTools array is non-empty', () => {
    expect(schema.mcpTools.length).toBeGreaterThan(0);
  });

  it('each command has required fields', () => {
    for (const cmd of schema.commands) {
      expect(cmd).toHaveProperty('name');
      expect(cmd).toHaveProperty('description');
      expect(Array.isArray(cmd.arguments)).toBe(true);
      expect(Array.isArray(cmd.options)).toBe(true);
      expect(Array.isArray(cmd.examples)).toBe(true);
    }
  });

  it('each REST endpoint has method, path, and description', () => {
    for (const ep of schema.restApi) {
      expect(ep).toHaveProperty('method');
      expect(ep).toHaveProperty('path');
      expect(ep).toHaveProperty('description');
    }
  });

  it('each MCP tool has name, description, and params array', () => {
    for (const tool of schema.mcpTools) {
      expect(tool).toHaveProperty('name');
      expect(tool).toHaveProperty('description');
      expect(Array.isArray(tool.params)).toBe(true);
    }
  });

  it('includes the dispatch_task MCP tool with required params', () => {
    const dispatch = schema.mcpTools.find(t => t.name === 'dispatch_task');
    expect(dispatch).toBeDefined();
    const requiredParams = dispatch!.params.filter(p => p.required).map(p => p.name);
    expect(requiredParams).toContain('agentName');
    expect(requiredParams).toContain('prompt');
  });

  it('includes the run command with --on required option', () => {
    const run = schema.commands.find(c => c.name === 'run');
    expect(run).toBeDefined();
    const onOpt = run!.options.find(o => o.flags.includes('--on'));
    expect(onOpt).toBeDefined();
    expect(onOpt!.required).toBe(true);
  });

  it('includes at least 10 REST endpoints', () => {
    expect(schema.restApi.length).toBeGreaterThanOrEqual(10);
  });

  it('includes at least 15 CLI commands', () => {
    expect(schema.commands.length).toBeGreaterThanOrEqual(15);
  });
});

// Import beforeAll explicitly (vitest auto-imports in some setups but safer to be explicit)
import { beforeAll } from 'vitest';
