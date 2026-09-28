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
  /** Named groups, or null/undefined when the pattern declares none. */
  groups?: Record<string, string | undefined> | null;
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
    matches.push({ index: m.index, length: m[0].length, captures: Array.from(m), groups: m.groups ? { ...m.groups } : null });
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

export type ReplacementToken =
  | { kind: 'literal'; text: string }
  | { kind: 'match' }
  | { kind: 'prefix' }
  | { kind: 'suffix' }
  | { kind: 'capture'; index: number }
  | { kind: 'named'; name: string };

/**
 * Parse a String.prototype.replace-style template once, for a pattern with
 * `captureCount` numbered groups and (when `hasNamedGroups`) a named-group map.
 *
 * A hand-written, single-pass implementation of ECMAScript GetSubstitution:
 * `$$`, `$&`, `$\``, `$'`, `$n`/`$nn` (with the two-digit fallback), and
 * `$<name>`. Work is linear in the template length even for many unterminated
 * `$<` sequences, because the next `>` is located once and reused (AUDIT R7).
 * The token list is reused for every match of the same edit (AUDIT R8).
 */
export function parseReplacementTemplate(
  template: string,
  captureCount: number,
  hasNamedGroups: boolean,
): ReplacementToken[] {
  const tokens: ReplacementToken[] = [];
  const len = template.length;
  let pos = 0;
  let runStart = 0;
  // Position of the next '>' at or after `gtFrom`; -1 means none anywhere later.
  let gtFrom = 0;
  let nextGt = template.indexOf('>');
  const flush = (end: number) => {
    if (end > runStart) tokens.push({ kind: 'literal', text: template.slice(runStart, end) });
  };
  while (pos < len) {
    const dollar = template.indexOf('$', pos);
    if (dollar === -1 || dollar === len - 1) break;
    const next = template.charCodeAt(dollar + 1);
    let consumed = 2;
    let token: ReplacementToken;
    if (next === 0x24)
      token = { kind: 'literal', text: '$' }; // $$
    else if (next === 0x26)
      token = { kind: 'match' }; // $&
    else if (next === 0x60)
      token = { kind: 'prefix' }; // $`
    else if (next === 0x27)
      token = { kind: 'suffix' }; // $'
    else if (next >= 0x30 && next <= 0x39) {
      // $n or $nn: prefer two digits when that group exists, else one digit.
      const d1 = next - 0x30;
      const c2 = dollar + 2 < len ? template.charCodeAt(dollar + 2) : -1;
      const twoDigit = c2 >= 0x30 && c2 <= 0x39;
      let index = twoDigit ? d1 * 10 + (c2 - 0x30) : d1;
      let digits = twoDigit ? 2 : 1;
      if (twoDigit && index > captureCount) {
        index = d1;
        digits = 1;
      }
      consumed = 1 + digits;
      token =
        index >= 1 && index <= captureCount
          ? { kind: 'capture', index }
          : { kind: 'literal', text: template.slice(dollar, dollar + consumed) }; // "$0", "$9", ...
    } else if (next === 0x3c) {
      // $<
      if (!hasNamedGroups) {
        // No named groups: "$<" is literal and parsing continues right after it.
        token = { kind: 'literal', text: '$<' };
      } else {
        if (nextGt !== -1 && nextGt < dollar + 2) {
          if (gtFrom <= nextGt) {
            nextGt = template.indexOf('>', dollar + 2);
            gtFrom = dollar + 2;
          }
        }
        if (nextGt === -1) token = { kind: 'literal', text: '$<' };
        else {
          token = { kind: 'named', name: template.slice(dollar + 2, nextGt) };
          consumed = nextGt + 1 - dollar;
        }
      }
    } else {
      // "$" followed by anything else is a literal "$"; keep parsing at the next char.
      token = { kind: 'literal', text: '$' };
      consumed = 1;
    }
    flush(dollar);
    tokens.push(token);
    pos = dollar + consumed;
    runStart = pos;
  }
  flush(len);
  return tokens;
}

/**
 * Emit the expansion of parsed tokens for one match, piece by piece, so an
 * `emit` that enforces a byte budget bounds the output before any large string
 * exists (AUDIT R3). Named captures are substituted only for own properties of
 * the group map, because the map crossed a worker boundary and no longer has a
 * null prototype (AUDIT R4).
 */
export function expandTokensInto(
  tokens: readonly ReplacementToken[],
  match: RegexMatch,
  content: string,
  emit: (piece: string) => void,
): void {
  const groups = match.groups ?? undefined;
  for (const token of tokens) {
    switch (token.kind) {
      case 'literal':
        emit(token.text);
        break;
      case 'match':
        emit(match.captures[0] ?? '');
        break;
      case 'prefix':
        emit(content.slice(0, match.index));
        break;
      case 'suffix':
        emit(content.slice(match.index + match.length));
        break;
      case 'capture':
        emit(match.captures[token.index] ?? '');
        break;
      case 'named':
        emit(
          groups !== undefined && Object.hasOwn(groups, token.name)
            ? (groups[token.name] ?? '')
            : '',
        );
        break;
    }
  }
}

/** Parse and expand for one match (tests and one-off callers). */
export function expandReplacementInto(
  template: string,
  match: RegexMatch,
  content: string,
  literal: boolean,
  emit: (piece: string) => void,
): void {
  if (literal) {
    emit(template);
    return;
  }
  const tokens = parseReplacementTemplate(
    template,
    match.captures.length - 1,
    match.groups !== undefined && match.groups !== null,
  );
  expandTokensInto(tokens, match, content, emit);
}

/** Convenience wrapper without a budget; the edit path uses expandReplacementInto. */
export function expandReplacement(
  template: string,
  match: RegexMatch,
  content: string,
  literal: boolean,
): string {
  const parts: string[] = [];
  expandReplacementInto(template, match, content, literal, (piece) => {
    parts.push(piece);
  });
  return parts.join('');
}
