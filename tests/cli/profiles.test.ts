import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock config module before importing commands
vi.mock('../../src/shared/config.js', () => ({
  loadConfig: vi.fn(),
  saveConfig: vi.fn(),
  requireConfig: vi.fn(),
}));

// Mock the AgentDaemon so the agent command doesn't try to connect
vi.mock('../../src/agent/daemon.js', () => ({
  AgentDaemon: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { loadConfig, saveConfig, requireConfig } from '../../src/shared/config.js';
import type { CoordConfig, AgentProfile } from '../../src/shared/config.js';
import { profilesCommand } from '../../src/cli/commands/profiles.js';
import { agentCommand } from '../../src/cli/commands/agent.js';
import { AgentDaemon } from '../../src/agent/daemon.js';

const mockLoadConfig = vi.mocked(loadConfig);
const mockSaveConfig = vi.mocked(saveConfig);
const mockRequireConfig = vi.mocked(requireConfig);
const MockAgentDaemon = vi.mocked(AgentDaemon);

function makeConfig(overrides?: Partial<CoordConfig>): CoordConfig {
  return { token: 'test-token', coordinatorUrl: 'ws://localhost:8080', ...overrides };
}

function makeProfile(overrides?: Partial<AgentProfile>): AgentProfile {
  return {
    url: 'wss://host:8080',
    token: 'profile-token',
    name: 'ops-agent',
    ...overrides,
  };
}

describe('profiles command', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as () => never);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  describe('profiles list', () => {
    it('prints "No profiles found" when there are no profiles', async () => {
      mockLoadConfig.mockReturnValue(makeConfig({ agentProfiles: {} }));

      await profilesCommand.parseAsync(['list'], { from: 'user' });

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No profiles found'));
    });

    it('prints "No profiles found" when agentProfiles is undefined', async () => {
      mockLoadConfig.mockReturnValue(makeConfig());

      await profilesCommand.parseAsync(['list'], { from: 'user' });

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No profiles found'));
    });

    it('lists profile names and key fields', async () => {
      mockLoadConfig.mockReturnValue(makeConfig({
        agentProfiles: {
          ops: makeProfile({ url: 'wss://ops.example.com:8080', name: 'ops-agent', maxConcurrent: 2, isolation: 'worktree' }),
          dev: makeProfile({ url: 'wss://dev.example.com:8080', name: 'dev-agent' }),
        },
      }));

      await profilesCommand.parseAsync(['list'], { from: 'user' });

      const output = consoleSpy.mock.calls.map(c => c[0] as string).join('\n');
      expect(output).toContain('ops');
      expect(output).toContain('dev');
      expect(output).toContain('wss://ops.example.com:8080');
      expect(output).toContain('ops-agent');
    });
  });

  describe('profiles show', () => {
    it('prints profile as JSON', async () => {
      const profile = makeProfile({ allowedTools: ['Read', 'Write'], maxConcurrent: 3 });
      mockLoadConfig.mockReturnValue(makeConfig({ agentProfiles: { ops: profile } }));

      await profilesCommand.parseAsync(['show', 'ops'], { from: 'user' });

      const printed = consoleSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(printed);
      expect(parsed.url).toBe('wss://host:8080');
      expect(parsed.token).toBe('profile-token');
      expect(parsed.name).toBe('ops-agent');
      expect(parsed.allowedTools).toEqual(['Read', 'Write']);
      expect(parsed.maxConcurrent).toBe(3);
    });

    it('exits with code 1 when profile not found', async () => {
      mockLoadConfig.mockReturnValue(makeConfig({ agentProfiles: {} }));

      await expect(
        profilesCommand.parseAsync(['show', 'nonexistent'], { from: 'user' }),
      ).rejects.toThrow('process.exit called');

      expect(consoleErrSpy).toHaveBeenCalledWith(expect.stringContaining('nonexistent'));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('profiles create', () => {
    it('creates a new profile and saves config', async () => {
      const baseConfig = makeConfig();
      mockRequireConfig.mockReturnValue(baseConfig);

      await profilesCommand.parseAsync([
        'create', 'ops',
        '--url', 'wss://host:8080',
        '--token', 'tok123',
        '--name', 'ops-agent',
        '--max-concurrent', '2',
        '--isolation', 'worktree',
        '--allowed-tools', 'Read,Write,Edit',
      ], { from: 'user' });

      expect(mockSaveConfig).toHaveBeenCalledTimes(1);
      const saved = mockSaveConfig.mock.calls[0][0];
      const profile = saved.agentProfiles?.['ops'];
      expect(profile).toBeDefined();
      expect(profile?.url).toBe('wss://host:8080');
      expect(profile?.token).toBe('tok123');
      expect(profile?.name).toBe('ops-agent');
      expect(profile?.maxConcurrent).toBe(2);
      expect(profile?.isolation).toBe('worktree');
      expect(profile?.allowedTools).toEqual(['Read', 'Write', 'Edit']);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('ops'));
    });

    it('updates an existing profile', async () => {
      const baseConfig = makeConfig({
        agentProfiles: { ops: makeProfile({ maxConcurrent: 1 }) },
      });
      mockRequireConfig.mockReturnValue(baseConfig);

      await profilesCommand.parseAsync([
        'create', 'ops',
        '--url', 'wss://updated:8080',
        '--token', 'new-token',
        '--name', 'ops-agent',
      ], { from: 'user' });

      const saved = mockSaveConfig.mock.calls[0][0];
      expect(saved.agentProfiles?.['ops']?.url).toBe('wss://updated:8080');
      expect(saved.agentProfiles?.['ops']?.token).toBe('new-token');
    });

    it('saves all optional fields when provided', async () => {
      mockRequireConfig.mockReturnValue(makeConfig());

      await profilesCommand.parseAsync([
        'create', 'full',
        '--url', 'wss://host:8080',
        '--token', 'tok',
        '--name', 'agent',
        '--cwd', '/home/user',
        '--dangerously-skip-permissions',
        '--disallowed-tools', 'Bash',
        '--add-dirs', '/etc,/var/log',
        '--permission-mode', 'auto',
        '--pool', 'staging',
      ], { from: 'user' });

      const profile = mockSaveConfig.mock.calls[0][0].agentProfiles?.['full'];
      expect(profile?.cwd).toBe('/home/user');
      expect(profile?.dangerouslySkipPermissions).toBe(true);
      expect(profile?.disallowedTools).toEqual(['Bash']);
      expect(profile?.addDirs).toEqual(['/etc', '/var/log']);
      expect(profile?.permissionMode).toBe('auto');
      expect(profile?.pool).toBe('staging');
    });
  });

  describe('profiles delete', () => {
    it('removes profile and saves config', async () => {
      const baseConfig = makeConfig({
        agentProfiles: {
          ops: makeProfile(),
          dev: makeProfile({ name: 'dev-agent' }),
        },
      });
      mockRequireConfig.mockReturnValue(baseConfig);

      await profilesCommand.parseAsync(['delete', 'ops'], { from: 'user' });

      expect(mockSaveConfig).toHaveBeenCalledTimes(1);
      const saved = mockSaveConfig.mock.calls[0][0];
      expect(saved.agentProfiles?.['ops']).toBeUndefined();
      expect(saved.agentProfiles?.['dev']).toBeDefined();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('ops'));
    });

    it('exits with code 1 when profile not found', async () => {
      mockRequireConfig.mockReturnValue(makeConfig({ agentProfiles: {} }));

      await expect(
        profilesCommand.parseAsync(['delete', 'ghost'], { from: 'user' }),
      ).rejects.toThrow('process.exit called');

      expect(consoleErrSpy).toHaveBeenCalledWith(expect.stringContaining('ghost'));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});

describe('agent command with --profile', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as () => never);

    // Set up a default successful daemon mock
    MockAgentDaemon.mockImplementation(() => ({
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    }));
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('loads profile and uses its values when no CLI flags override', async () => {
    mockLoadConfig.mockReturnValue(makeConfig({
      agentProfiles: {
        ops: makeProfile({ maxConcurrent: 2, isolation: 'worktree' }),
      },
    }));

    await agentCommand.parseAsync(['--profile', 'ops'], { from: 'user' });

    expect(MockAgentDaemon).toHaveBeenCalledWith(expect.objectContaining({
      coordinatorUrl: 'wss://host:8080',
      token: 'profile-token',
      name: 'ops-agent',
      maxConcurrent: 2,
      isolation: 'worktree',
    }));
  });

  it('CLI flags override profile values', async () => {
    mockLoadConfig.mockReturnValue(makeConfig({
      agentProfiles: {
        ops: makeProfile({ url: 'wss://profile-host:8080', name: 'ops-agent', maxConcurrent: 1 }),
      },
    }));

    await agentCommand.parseAsync([
      '--profile', 'ops',
      '--url', 'wss://override:9090',
      '--max-concurrent', '4',
    ], { from: 'user' });

    expect(MockAgentDaemon).toHaveBeenCalledWith(expect.objectContaining({
      coordinatorUrl: 'wss://override:9090',
      maxConcurrent: 4,
      name: 'ops-agent', // from profile, not overridden
    }));
  });

  it('--name CLI flag overrides profile name', async () => {
    mockLoadConfig.mockReturnValue(makeConfig({
      agentProfiles: {
        ops: makeProfile(),
      },
    }));

    await agentCommand.parseAsync([
      '--profile', 'ops',
      '--name', 'cli-override-name',
    ], { from: 'user' });

    expect(MockAgentDaemon).toHaveBeenCalledWith(expect.objectContaining({
      name: 'cli-override-name',
    }));
  });

  it('exits with code 1 when profile name does not exist', async () => {
    mockLoadConfig.mockReturnValue(makeConfig({ agentProfiles: {} }));

    await expect(
      agentCommand.parseAsync(['--profile', 'nonexistent'], { from: 'user' }),
    ).rejects.toThrow('process.exit called');

    expect(consoleErrSpy).toHaveBeenCalledWith(expect.stringContaining('nonexistent'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with code 1 when url is missing after merge', async () => {
    mockLoadConfig.mockReturnValue(makeConfig({
      agentProfiles: {
        partial: { token: 'tok', name: 'agent' }, // no url
      },
    }));

    await expect(
      agentCommand.parseAsync(['--profile', 'partial'], { from: 'user' }),
    ).rejects.toThrow('process.exit called');

    expect(consoleErrSpy).toHaveBeenCalledWith(expect.stringContaining('--url'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with code 1 when token is missing after merge', async () => {
    mockLoadConfig.mockReturnValue(makeConfig({
      agentProfiles: {
        partial: { url: 'wss://host:8080', name: 'agent' }, // no token
      },
    }));

    await expect(
      agentCommand.parseAsync(['--profile', 'partial'], { from: 'user' }),
    ).rejects.toThrow('process.exit called');

    expect(consoleErrSpy).toHaveBeenCalledWith(expect.stringContaining('--token'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with code 1 when name is missing after merge', async () => {
    mockLoadConfig.mockReturnValue(makeConfig({
      agentProfiles: {
        partial: { url: 'wss://host:8080', token: 'tok' }, // no name
      },
    }));

    await expect(
      agentCommand.parseAsync(['--profile', 'partial'], { from: 'user' }),
    ).rejects.toThrow('process.exit called');

    expect(consoleErrSpy).toHaveBeenCalledWith(expect.stringContaining('--name'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with code 1 when required fields missing without profile', async () => {
    // No profile, no --url
    await expect(
      agentCommand.parseAsync(['--token', 'tok', '--name', 'agent'], { from: 'user' }),
    ).rejects.toThrow('process.exit called');

    expect(consoleErrSpy).toHaveBeenCalledWith(expect.stringContaining('--url'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('loads allowedTools array from profile correctly', async () => {
    mockLoadConfig.mockReturnValue(makeConfig({
      agentProfiles: {
        tools: makeProfile({ allowedTools: ['Read', 'Write', 'Edit'] }),
      },
    }));

    await agentCommand.parseAsync(['--profile', 'tools'], { from: 'user' });

    expect(MockAgentDaemon).toHaveBeenCalledWith(expect.objectContaining({
      allowedTools: ['Read', 'Write', 'Edit'],
    }));
  });

  it('enforces mutual exclusion: dangerouslySkipPermissions from profile vs --allowed-tools CLI flag', async () => {
    mockLoadConfig.mockReturnValue(makeConfig({
      agentProfiles: {
        dangerous: makeProfile({ dangerouslySkipPermissions: true }),
      },
    }));

    await expect(
      agentCommand.parseAsync([
        '--profile', 'dangerous',
        '--allowed-tools', 'Read',
      ], { from: 'user' }),
    ).rejects.toThrow('process.exit called');

    expect(consoleErrSpy).toHaveBeenCalledWith(expect.stringContaining('mutually exclusive'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('starts daemon with direct flags when no profile is specified', async () => {
    await agentCommand.parseAsync([
      '--url', 'wss://direct:8080',
      '--token', 'direct-token',
      '--name', 'direct-agent',
      '--max-concurrent', '3',
    ], { from: 'user' });

    expect(MockAgentDaemon).toHaveBeenCalledWith(expect.objectContaining({
      coordinatorUrl: 'wss://direct:8080',
      token: 'direct-token',
      name: 'direct-agent',
      maxConcurrent: 3,
    }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('direct-agent'));
  });
});
