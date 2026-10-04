const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

function emit(level, scope, msg, extra) {
  if (LEVELS[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  stream.write(extra === undefined ? `${line}\n` : `${line} ${safe(extra)}\n`);
}

function safe(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function logger(scope) {
  return {
    debug: (msg, extra) => emit('debug', scope, msg, extra),
    info: (msg, extra) => emit('info', scope, msg, extra),
    warn: (msg, extra) => emit('warn', scope, msg, extra),
    error: (msg, extra) => emit('error', scope, msg, extra),
    child: (sub) => logger(`${scope}:${sub}`),
  };
}
