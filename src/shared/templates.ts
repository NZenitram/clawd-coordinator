import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface TaskTemplateVariable {
  description?: string;
  required?: boolean;
  default?: string;
}

export interface TaskTemplate {
  name: string;
  description?: string;
  prompt: string;
  on?: string;
  budget?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  addDirs?: string[];
  upload?: string[];
  download?: string[];
  variables?: Record<string, TaskTemplateVariable>;
}

export function getTemplatesDir(): string {
  return join(homedir(), '.coord', 'templates');
}

function templatePath(name: string): string {
  return join(getTemplatesDir(), `${name}.json`);
}

export function loadTemplate(name: string): TaskTemplate | null {
  const filePath = templatePath(name);
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.name !== 'string' || typeof parsed.prompt !== 'string') {
      throw new Error('Invalid template: missing name or prompt');
    }
    return parsed as TaskTemplate;
  } catch (err) {
    throw new Error(
      `Failed to read template "${name}" at ${filePath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export function listTemplates(): TaskTemplate[] {
  const dir = getTemplatesDir();
  if (!existsSync(dir)) {
    return [];
  }
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const templates: TaskTemplate[] = [];
  for (const file of files) {
    const name = file.slice(0, -5);
    try {
      const tmpl = loadTemplate(name);
      if (tmpl) templates.push(tmpl);
    } catch {
      // skip malformed templates
    }
  }
  return templates;
}

export function saveTemplate(template: TaskTemplate): void {
  const dir = getTemplatesDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    templatePath(template.name),
    JSON.stringify(template, null, 2) + '\n',
    { encoding: 'utf-8', mode: 0o600 }
  );
}

export function deleteTemplate(name: string): void {
  const filePath = templatePath(name);
  if (!existsSync(filePath)) {
    throw new Error(`Template "${name}" not found`);
  }
  unlinkSync(filePath);
}

export function substituteVariables(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : `{{${key}}}`;
  });
}

export function parseVars(varsString: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!varsString.trim()) return result;
  for (const pair of varsString.split(',')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    const key = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

export function validateVariables(
  template: TaskTemplate,
  vars: Record<string, string>
): string[] {
  const missing: string[] = [];
  if (!template.variables) return missing;

  for (const [key, def] of Object.entries(template.variables)) {
    const hasValue = Object.prototype.hasOwnProperty.call(vars, key) && vars[key] !== undefined;
    const hasDefault = def.default !== undefined;
    if (!hasValue && !hasDefault && def.required) {
      missing.push(key);
    }
  }
  return missing;
}

/**
 * Build a fully-resolved vars map, applying defaults for any variables not
 * explicitly provided by the caller.
 */
export function resolveVariables(
  template: TaskTemplate,
  vars: Record<string, string>
): Record<string, string> {
  const resolved: Record<string, string> = { ...vars };
  if (!template.variables) return resolved;

  for (const [key, def] of Object.entries(template.variables)) {
    if (!Object.prototype.hasOwnProperty.call(resolved, key) && def.default !== undefined) {
      resolved[key] = def.default;
    }
  }
  return resolved;
}
