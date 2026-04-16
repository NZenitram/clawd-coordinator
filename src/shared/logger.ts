const LEVELS: Record<string, number> = {
  silent: Infinity,
  error: 50,
  warn: 40,
  info: 30,
  debug: 20,
  trace: 10,
};

const configuredLevel = LEVELS[process.env.COORD_LOG_LEVEL ?? 'info'] ?? 30;

function log(level: number, levelName: string, objOrMsg: unknown, msg?: string): void {
  if (level < configuredLevel) return;
  const entry: Record<string, unknown> = {
    level,
    time: Date.now(),
    pid: process.pid,
    hostname: '',
  };
  if (typeof objOrMsg === 'string') {
    entry.msg = objOrMsg;
  } else if (typeof objOrMsg === 'object' && objOrMsg !== null) {
    Object.assign(entry, objOrMsg);
    if (msg) entry.msg = msg;
  }
  const line = JSON.stringify(entry);
  if (level >= 50) {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

export const logger = {
  trace: (obj: unknown, msg?: string) => log(10, 'trace', obj, msg),
  debug: (obj: unknown, msg?: string) => log(20, 'debug', obj, msg),
  info: (obj: unknown, msg?: string) => log(30, 'info', obj, msg),
  warn: (obj: unknown, msg?: string) => log(40, 'warn', obj, msg),
  error: (obj: unknown, msg?: string) => log(50, 'error', obj, msg),
};
