/**
 * In-memory idempotency store for create operations.
 *
 * - A retry carrying the same key gets the original result instead of a second note.
 * - Concurrent requests with the same key are coalesced onto one in-flight
 *   operation (the second waits for the first).
 * - The key is bound to a fingerprint of the request; reusing a key with a
 *   different payload is rejected instead of silently returning another note.
 *
 * Process-local by design: a restart forgets keys and a multi-instance
 * deployment does not share them. The deployment docs say so.
 */
import { createHash } from 'node:crypto';

export interface IdempotencyRecord {
  noteId: string;
  contentHash: string;
  fingerprint: string;
  createdAt: number;
}

interface Entry {
  fingerprint: string;
  createdAt: number;
  record?: IdempotencyRecord;
  inFlight?: Promise<IdempotencyRecord>;
}

export class IdempotencyKeyMismatch extends Error {
  override readonly name = 'IdempotencyKeyMismatch';
}

export function fingerprintOf(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('base64url').slice(0, 32);
}

export class IdempotencyStore {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    this.maxEntries = options.maxEntries ?? 10_000;
    this.now = options.now ?? (() => Date.now());
  }

  private key(principal: string, key: string): string {
    return `${principal}\u0000${key}`;
  }

  private live(entry: Entry | undefined, key: string): Entry | undefined {
    if (!entry) return undefined;
    if (!entry.inFlight && this.now() - entry.createdAt > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  /**
   * Run `create` exactly once per (principal, key). A second caller with the
   * same key and fingerprint receives the first caller's record (`replayed`);
   * a caller with a different fingerprint gets IdempotencyKeyMismatch.
   */
  async execute(
    principal: string,
    key: string,
    fingerprint: string,
    create: (
      record: (partial: Omit<IdempotencyRecord, 'fingerprint' | 'createdAt'>) => void,
    ) => Promise<Omit<IdempotencyRecord, 'fingerprint' | 'createdAt'>>,
  ): Promise<{ record: IdempotencyRecord; replayed: boolean }> {
    const k = this.key(principal, key);
    const existing = this.live(this.entries.get(k), k);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new IdempotencyKeyMismatch(
          `idempotencyKey '${key}' was already used with a different request`,
        );
      if (existing.record) return { record: existing.record, replayed: true };
      if (existing.inFlight) return { record: await existing.inFlight, replayed: true };
    }
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    const entry: Entry = { fingerprint, createdAt: this.now() };
    // `record` lets the operation persist the note id as soon as it exists, so a
    // failure later in the operation (attributes, final read) does not lose it.
    const commit = (partial: Omit<IdempotencyRecord, 'fingerprint' | 'createdAt'>) => {
      entry.record = { ...partial, fingerprint, createdAt: this.now() };
    };
    entry.inFlight = (async () => {
      try {
        const result = await create(commit);
        commit(result);
        return entry.record!;
      } catch (err) {
        if (entry.record) return entry.record; // upstream create succeeded; keep it
        this.entries.delete(k);
        throw err;
      } finally {
        delete entry.inFlight;
      }
    })();
    this.entries.set(k, entry);
    return { record: await entry.inFlight, replayed: false };
  }

  get(principal: string, key: string): IdempotencyRecord | undefined {
    const k = this.key(principal, key);
    return this.live(this.entries.get(k), k)?.record;
  }

  get size(): number {
    return this.entries.size;
  }
}
