import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface CoordConfig {
  token: string;
  coordinatorUrl?: string;
  port?: number;
  tls?: {
    cert: string;
    key: string;
  };
}

const CONFIG_DIR = join(homedir(), '.coord');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}

export function loadConfig(): CoordConfig | null {
  if (!existsSync(CONFIG_FILE)) {
    return null;
  }
  const raw = readFileSync(CONFIG_FILE, 'utf-8');
  return JSON.parse(raw) as CoordConfig;
}

export function saveConfig(config: CoordConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
}

export function requireConfig(): CoordConfig {
  const config = loadConfig();
  if (!config) {
    console.error('No config found. Run "coord init" first.');
    process.exit(1);
  }
  return config;
}
