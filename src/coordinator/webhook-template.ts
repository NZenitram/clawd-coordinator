/**
 * Resolves {{path.to.field}} and {{array[0].field}} style templates
 * against a JSON payload.
 */
export function resolveTemplate(template: string, payload: unknown): string {
  return template.replace(/\{\{(.+?)\}\}/g, (_, pathStr: string) => {
    const value = resolvePath(payload, pathStr.trim());
    return value !== undefined && value !== null ? String(value) : '';
  });
}

function resolvePath(obj: unknown, path: string): unknown {
  // Split on '.' but first normalise array indices: 'commits[0]' -> 'commits.0'
  const normalised = path.replace(/\[(\d+)\]/g, '.$1');
  const parts = normalised.split('.');

  let current: unknown = obj;
  for (const part of parts) {
    if (part === '') continue;
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
