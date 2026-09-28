/**
 * Minimal structured logger. Writes one JSON object per line to stderr so the
 * stdio transport's stdout stays a clean JSON-RPC channel. No dependency.
 */
import { appendFileSync } from 'node:fs';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  level: LogLevel;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  format?: 'json' | 'pretty';
  sink?: (line: string) => void;
  bindings?: LogFields;
  clock?: () => Date;
}

const REDACT_KEYS = /token|secret|password|authorization|cookie/i;

/** Replace secret-looking fields so a misplaced log line cannot leak credentials. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        ...(value.stack ? { stack: value.stack } : {}),
      };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.test(k) && typeof v === 'string' ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const format = options.format ?? 'json';
  const sink = options.sink ?? ((line: string) => process.stderr.write(`${line}\n`));
  const clock = options.clock ?? (() => new Date());
  const bindings = options.bindings ?? {};

  const emit = (lvl: LogLevel, msg: string, fields?: LogFields) => {
    if (LEVELS[lvl] < LEVELS[level]) return;
    const record = {
      time: clock().toISOString(),
      level: lvl,
      msg,
      ...bindings,
      ...(fields ? (redact(fields) as LogFields) : {}),
    };
    if (format === 'json') {
      sink(JSON.stringify(record));
    } else {
      const { time, level: l, msg: m, ...rest } = record;
      const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
      sink(`${time} ${l.toUpperCase().padEnd(5)} ${m}${extra}`);
    }
  };

  return {
    level,
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (more) => createLogger({ ...options, bindings: { ...bindings, ...more } }),
  };
}

export const silentLogger: Logger = createLogger({ level: 'error', sink: () => undefined });

/** Audit events answer: who invoked which tool against which notes, and did it succeed. Never bodies. */
export interface AuditEvent {
  principal: string;
  client: string;
  subject?: string;
  transport: 'stdio' | 'http';
  tool: string;
  noteIds: string[];
  ok: boolean;
  code?: string;
  durationMs: number;
  era?: 'legacy' | 'modern';
  requestId?: string;
}

export interface AuditLog {
  record(event: AuditEvent): void;
}

export function createAuditLog(options: {
  enabled: boolean;
  path?: string | undefined;
  logger: Logger;
  /** Where audit lines go when no file is configured. Independent of LOG_LEVEL. */
  sink?: (line: string) => void;
  clock?: () => Date;
}): AuditLog {
  const clock = options.clock ?? (() => new Date());
  if (!options.enabled) return { record: () => undefined };
  const file = options.path;
  const sink = options.sink ?? ((line: string) => process.stderr.write(`${line}\n`));
  return {
    record(event) {
      const line = JSON.stringify({ time: clock().toISOString(), type: 'audit', ...event });
      if (file) {
        try {
          appendFileSync(file, `${line}\n`);
          return;
        } catch (err) {
          options.logger.error('audit log write failed, falling back to stderr', {
            err,
            path: file,
          });
        }
      }
      sink(line);
    },
  };
}
