/**
 * Runs caller-supplied regular expressions off the event loop.
 *
 * A pathological pattern (catastrophic backtracking) or a zero-length match
 * loop must not freeze the server. Each scan runs in a short-lived worker
 * thread with a wall-clock budget; on timeout the worker is terminated and the
 * caller gets a VALIDATION error. The worker only finds matches; replacement
 * text is expanded on the main thread from the captured groups, so
 * context-sensitive patterns (lookarounds, anchors) behave like
 * String.prototype.replace.
 */
import { Worker } from 'node:worker_threads';
import { DomainError } from './errors.js';

export interface RegexMatch {
  index: number;
  length: number;
  /** m[0], m[1], ... as returned by RegExp.exec (undefined for unmatched groups). */
  captures: (string | undefined)[];
  groups?: Record<string, string | undefined>;
}

export interface ScanResult {
  matches: RegexMatch[];
  /** Number of non-empty matches found before stopping. */
  total: number;
  /** True when scanning stopped at `maxTotal`. */
  truncated: boolean;
  /** True when the pattern produced at least one empty match (skipped). */
  sawEmptyMatch: boolean;
}

export interface ScanOptions {
  content: string;
  source: string;
  flags: string;
  /** Matches returned with captures (the rest are only counted). */
  maxMatches: number;
  /** Stop counting after this many matches. */
  maxTotal?: number;
  timeoutMs?: number;
}

export const SAFE_FLAGS = /^[gimsuy]*$/;
export const DEFAULT_REGEX_TIMEOUT_MS = 2000;

export function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Validate a pattern on the main thread so syntax errors are cheap and precise. */
export function compilePattern(
  source: string,
  flags: string,
  where: string,
): { source: string; flags: string } {
  if (!SAFE_FLAGS.test(flags))
    throw DomainError.validation(`${where}: invalid regex flags '${flags}'`);
  const normalized = flags.replace(/g/g, '');
  try {
    new RegExp(source, normalized);
  } catch (err) {
    throw DomainError.validation(`${where}: invalid pattern: ${(err as Error).message}`);
  }
  return { source, flags: normalized };
}

// Plain JavaScript so it can run in an eval worker without a build step.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { content, source, flags, maxMatches, maxTotal } = workerData;
const re = new RegExp(source, flags.includes('g') ? flags : flags + 'g');
const matches = [];
let total = 0;
let truncated = false;
let sawEmptyMatch = false;
let m;
while ((m = re.exec(content)) !== null) {
  if (m[0].length === 0) {
    sawEmptyMatch = true;
    // Advance by one code point so a surrogate pair is never split (with the u
    // flag, a lastIndex inside a pair would re-match the same position forever).
    const cp = content.codePointAt(m.index);
    re.lastIndex = m.index + (cp !== undefined && cp > 0xffff ? 2 : 1);
    if (re.lastIndex > content.length) break;
    continue;
  }
  total += 1;
  if (matches.length < maxMatches) {
    matches.push({ index: m.index, length: m[0].length, captures: Array.from(m), groups: m.groups ? { ...m.groups } : undefined });
  }
  if (total >= maxTotal) { truncated = true; break; }
}
parentPort.postMessage({ matches, total, truncated, sawEmptyMatch });
`;

export function scanRegex(options: ScanOptions): Promise<ScanResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REGEX_TIMEOUT_MS;
  const maxTotal = options.maxTotal ?? 100_000;
  return new Promise<ScanResult>((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        content: options.content,
        source: options.source,
        flags: options.flags,
        maxMatches: options.maxMatches,
        maxTotal,
      },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() =>
        reject(
          DomainError.validation(
            `Pattern did not finish within ${timeoutMs}ms; simplify it (nested quantifiers such as (a+)+ are rejected by time, not by syntax)`,
            { timeoutMs },
          ),
        ),
      );
      void worker.terminate();
    }, timeoutMs);
    worker.once('message', (message: ScanResult) => {
      finish(() => resolve(message));
      void worker.terminate();
    });
    worker.once('error', (err: Error) => {
      finish(() => reject(DomainError.validation(`Pattern failed: ${err.message}`)));
    });
    worker.once('exit', (code) => {
      finish(() => reject(new DomainError('INTERNAL', `regex worker exited with code ${code}`)));
    });
  });
}

/**
 * Expand a String.prototype.replace-style template ($&, $1, $<name>, $$, $\`, $')
 * against one match of `content`. Returns the literal template when `literal`.
 */
export function expandReplacement(
  template: string,
  match: RegexMatch,
  content: string,
  literal: boolean,
): string {
  if (literal) return template;
  return template.replace(
    /\$(\$|&|`|'|\d{1,2}|<([^>]+)>)/g,
    (whole, token: string, name: string | undefined) => {
      if (token === '$') return '$';
      if (token === '&') return match.captures[0] ?? '';
      if (token === '`') return content.slice(0, match.index);
      if (token === "'") return content.slice(match.index + match.length);
      if (name !== undefined) return match.groups?.[name] ?? '';
      const n = Number(token);
      if (n >= 1 && n < match.captures.length) return match.captures[n] ?? '';
      if (token.length === 2) {
        // "$12" with fewer groups falls back to "$1" followed by "2", like replace().
        const first = Number(token[0]);
        if (first >= 1 && first < match.captures.length)
          return (match.captures[first] ?? '') + token[1];
      }
      return whole;
    },
  );
}
