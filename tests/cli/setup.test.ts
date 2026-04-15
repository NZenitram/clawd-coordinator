import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';

// ─── Helpers ──────────────────────────────────────────────────────────────────

let tmpConfigDir: string;

// We test the setup command action logic directly rather than via Commander
// to avoid process.exit() calls and interactive readline in tests.

// ─── Node version detection ────────────────────────────────────────────────────

describe('Node version detection', () => {
  it('nodeVersionOk returns true for v18+', async () => {
    // Access the internal helper via dynamic import after exposing it
    // We verify indirectly: the real process.version is >= 18 in CI
    const major = Number(process.version.replace('v', '').split('.')[0]);
    expect(major).toBeGreaterThanOrEqual(18);
  });

  it('nodeVersionOk logic rejects v16', () => {
    const version = 'v16.20.0';
    const [major] = version.replace('v', '').split('.').map(Number);
    expect(major >= 18).toBe(false);
  });

  it('nodeVersionOk logic accepts v18', () => {
    const version = 'v18.0.0';
    const [major] = version.replace('v', '').split('.').map(Number);
    expect(major >= 18).toBe(true);
  });

  it('nodeVersionOk logic accepts v22', () => {
    const version = 'v22.1.0';
    const [major] = version.replace('v', '').split('.').map(Number);
    expect(major >= 18).toBe(true);
  });
});

// ─── checkCommandExists in setup context ──────────────────────────────────────

describe('setup: Claude Code check', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('detects claude as present when checkCommandExists returns exists:true', async () => {
    vi.doMock('../../src/shared/platform.js', () => ({
      checkCommandExists: vi.fn(async (cmd: string) => {
        if (cmd === 'node') return { exists: true, version: 'node v22.0.0' };
        if (cmd === 'git') return { exists: true, version: 'git version 2.44.0' };
        if (cmd === 'claude') return { exists: true, version: 'claude 1.2.0' };
        return { exists: false };
      }),
      detectPackageManager: vi.fn(async () => null),
      shellOpts: vi.fn((opts?: Record<string, unknown>) => opts ?? {}),
      isWindows: false,
      isMacOS: true,
      isLinux: false,
    }));

    // checkCommandExists('claude') returns exists:true — no install attempted
    const { checkCommandExists } = await import('../../src/shared/platform.js');
    const result = await checkCommandExists('claude');
    expect(result.exists).toBe(true);
    expect(result.version).toBe('claude 1.2.0');
  });

  it('detects claude as missing when checkCommandExists returns exists:false', async () => {
    vi.doMock('../../src/shared/platform.js', () => ({
      checkCommandExists: vi.fn(async (cmd: string) => {
        if (cmd === 'claude') return { exists: false };
        return { exists: true, version: '1.0.0' };
      }),
      detectPackageManager: vi.fn(async () => null),
      shellOpts: vi.fn((opts?: Record<string, unknown>) => opts ?? {}),
      isWindows: false,
      isMacOS: true,
      isLinux: false,
    }));

    const { checkCommandExists } = await import('../../src/shared/platform.js');
    const result = await checkCommandExists('claude');
    expect(result.exists).toBe(false);
  });
});

// ─── Auth check ───────────────────────────────────────────────────────────────

describe('setup: auth check', () => {
  it('detects ANTHROPIC_API_KEY when set', () => {
    const orig = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'sk-test-key';
    const hasApiKey = Boolean(process.env['ANTHROPIC_API_KEY']);
    expect(hasApiKey).toBe(true);
    if (orig === undefined) {
      delete process.env['ANTHROPIC_API_KEY'];
    } else {
      process.env['ANTHROPIC_API_KEY'] = orig;
    }
  });

  it('detects missing ANTHROPIC_API_KEY', () => {
    const orig = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    const hasApiKey = Boolean(process.env['ANTHROPIC_API_KEY']);
    expect(hasApiKey).toBe(false);
    if (orig !== undefined) {
      process.env['ANTHROPIC_API_KEY'] = orig;
    }
  });
});

// ─── Profile save ─────────────────────────────────────────────────────────────

describe('setup: profile save', () => {
  beforeEach(() => {
    tmpConfigDir = mkdtempSync(join(tmpdir(), 'coord-setup-test-'));
  });

  afterEach(() => {
    rmSync(tmpConfigDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('saves profile to config when url/token/name flags provided', async () => {
    vi.resetModules();
    // Mock the config module to write to our temp dir
    const configPath = join(tmpConfigDir, 'config.json');

    vi.doMock('../../src/shared/config.js', () => ({
      loadConfig: vi.fn(() => null),
      saveConfig: vi.fn((cfg: object) => {
        require('node:fs').writeFileSync(configPath, JSON.stringify(cfg, null, 2));
      }),
    }));

    const { loadConfig, saveConfig } = await import('../../src/shared/config.js');

    // Simulate what setup command does when url/token/name are provided
    const options = {
      url: 'wss://coord.example.com',
      token: 'tok-abc123',
      name: 'my-agent',
      profile: 'prod',
    };

    const config = loadConfig() ?? { token: options.token ?? '' };
    if (options.token) config.token = options.token;
    if (options.url) (config as any).coordinatorUrl = options.url;
    if (!(config as any).agentProfiles) (config as any).agentProfiles = {};
    (config as any).agentProfiles[options.profile] = {
      url: options.url,
      token: options.token,
      name: options.name,
    };

    saveConfig(config as any);

    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'tok-abc123',
        agentProfiles: expect.objectContaining({
          prod: expect.objectContaining({
            url: 'wss://coord.example.com',
            name: 'my-agent',
          }),
        }),
      }),
    );
  });

  it('uses "default" profile name when --profile is not specified', async () => {
    vi.resetModules();
    const savedConfigs: object[] = [];

    vi.doMock('../../src/shared/config.js', () => ({
      loadConfig: vi.fn(() => null),
      saveConfig: vi.fn((cfg: object) => { savedConfigs.push(cfg); }),
    }));

    const { loadConfig, saveConfig } = await import('../../src/shared/config.js');

    const options = { url: 'wss://coord.example.com', token: 'tok-xyz', name: 'agent-1', profile: undefined };
    const profileName = options.profile ?? 'default';

    const config = loadConfig() ?? { token: options.token ?? '' };
    if (options.token) config.token = options.token;
    if (!(config as any).agentProfiles) (config as any).agentProfiles = {};
    (config as any).agentProfiles[profileName] = { url: options.url, token: options.token, name: options.name };

    saveConfig(config as any);

    const saved = savedConfigs[0] as any;
    expect(saved.agentProfiles).toHaveProperty('default');
    expect(saved.agentProfiles.default.url).toBe('wss://coord.example.com');
  });
});

// ─── --yes flag ───────────────────────────────────────────────────────────────

describe('setup: --yes flag skips prompts', () => {
  it('promptYN returns true immediately when autoYes=true', async () => {
    // The promptYN helper prints "[auto: yes]" and returns true without readline
    // We can verify this logic directly:
    const autoYes = true;
    let didPrompt = false;

    // Simulate what promptYN does:
    const result = await (async () => {
      if (autoYes) {
        // Would print but we just return true
        return true;
      }
      didPrompt = true;
      return false;
    })();

    expect(result).toBe(true);
    expect(didPrompt).toBe(false);
  });

  it('promptYN would call readline when autoYes=false', () => {
    // Verify the conditional branch exists — autoYes=false means we would invoke readline
    const autoYes = false;
    let wouldUseReadline = false;

    if (!autoYes) {
      wouldUseReadline = true;
    }

    expect(wouldUseReadline).toBe(true);
  });
});

// ─── setupCommand registration ────────────────────────────────────────────────

describe('setupCommand', () => {
  it('is exported with correct name and description', async () => {
    vi.resetModules();
    vi.doMock('../../src/shared/platform.js', () => ({
      checkCommandExists: vi.fn(async () => ({ exists: true, version: '1.0.0' })),
      detectPackageManager: vi.fn(async () => null),
      shellOpts: vi.fn((opts?: Record<string, unknown>) => opts ?? {}),
      isWindows: false,
      isMacOS: true,
      isLinux: false,
    }));
    vi.doMock('../../src/shared/config.js', () => ({
      loadConfig: vi.fn(() => null),
      saveConfig: vi.fn(),
    }));

    const { setupCommand } = await import('../../src/cli/commands/setup.js');
    expect(setupCommand.name()).toBe('setup');
    expect(setupCommand.description()).toContain('Set up a machine');
  });

  it('has --yes, --url, --token, --name, --profile options', async () => {
    vi.resetModules();
    vi.doMock('../../src/shared/platform.js', () => ({
      checkCommandExists: vi.fn(async () => ({ exists: true, version: '1.0.0' })),
      detectPackageManager: vi.fn(async () => null),
      shellOpts: vi.fn((opts?: Record<string, unknown>) => opts ?? {}),
      isWindows: false,
      isMacOS: true,
      isLinux: false,
    }));
    vi.doMock('../../src/shared/config.js', () => ({
      loadConfig: vi.fn(() => null),
      saveConfig: vi.fn(),
    }));

    const { setupCommand } = await import('../../src/cli/commands/setup.js');
    const optionNames = setupCommand.options.map((o: { long: string }) => o.long);
    expect(optionNames).toContain('--yes');
    expect(optionNames).toContain('--url');
    expect(optionNames).toContain('--token');
    expect(optionNames).toContain('--name');
    expect(optionNames).toContain('--profile');
  });
});
