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

export interface Checkpoint<T> {
  noteId: string;
  contentHash: string;
  /** Whatever the operation knows so far (attribute results, warnings). */
  partial: Partial<T>;
}

export interface IdempotencyRecord<T> {
  fingerprint: string;
  createdAt: number;
  /** Set once the whole operation finished; replays return this outcome. */
  outcome?: T;
  /** Set as soon as the note exists upstream; survives later failures. */
  checkpoint?: Checkpoint<T>;
  /** The error that ended an operation after its checkpoint. */
  failure?: { code: string; message: string };
}

interface Entry<T> {
  fingerprint: string;
  createdAt: number;
  record?: IdempotencyRecord<T>;
  inFlight?: Promise<IdempotencyRecord<T>>;
}

export class IdempotencyKeyMismatch extends Error {
  override readonly name = 'IdempotencyKeyMismatch';
}

export function fingerprintOf(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('base64url').slice(0, 32);
}

export class IdempotencyStore<T = unknown> {
  private readonly entries = new Map<string, Entry<T>>();
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

  private live(entry: Entry<T> | undefined, key: string): Entry<T> | undefined {
    if (!entry) return undefined;
    if (!entry.inFlight && this.now() - entry.createdAt > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  /**
   * Run `create` at most once per (principal, key).
   *
   * - A caller arriving while the first run is still in flight waits for it to
   *   finish and then receives the same record (`replayed: true`).
   * - A caller with the same key but a different fingerprint gets
   *   IdempotencyKeyMismatch.
   * - `checkpoint` lets the operation persist the note id (and partial results)
   *   as soon as the note exists; a failure after that keeps the record with
   *   `failure` set, so retries neither create a second note nor pretend the
   *   original completed.
   */
  async execute(
    principal: string,
    key: string,
    fingerprint: string,
    create: (checkpoint: (c: Checkpoint<T>) => void) => Promise<T>,
    describeFailure: (err: unknown) => { code: string; message: string },
  ): Promise<{ record: IdempotencyRecord<T>; replayed: boolean }> {
    const k = this.key(principal, key);
    const existing = this.live(this.entries.get(k), k);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new IdempotencyKeyMismatch(
          `idempotencyKey '${key}' was already used with a different request`,
        );
      if (existing.inFlight) return { record: await existing.inFlight, replayed: true };
      if (existing.record) return { record: existing.record, replayed: true };
    }
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    const entry: Entry<T> = { fingerprint, createdAt: this.now() };
    const base = (): IdempotencyRecord<T> => ({ fingerprint, createdAt: this.now() });
    let checkpointed: Checkpoint<T> | undefined;
    const checkpoint = (c: Checkpoint<T>) => {
      checkpointed = c;
    };
    entry.inFlight = (async () => {
      try {
        const outcome = await create(checkpoint);
        entry.record = {
          ...base(),
          outcome,
          ...(checkpointed ? { checkpoint: checkpointed } : {}),
        };
        return entry.record;
      } catch (err) {
        if (checkpointed) {
          // The note exists; remember it together with why the call failed.
          entry.record = { ...base(), checkpoint: checkpointed, failure: describeFailure(err) };
          throw err;
        }
        this.entries.delete(k);
        throw err;
      } finally {
        delete entry.inFlight;
      }
    })();
    this.entries.set(k, entry);
    // The first caller sees the failure. Concurrent waiters get the record when
    // the note exists, or the same failure when nothing was created (so they can retry).
    const inFlight = entry.inFlight;
    const waiterView = inFlight.catch((err: unknown) => {
      if (entry.record) return entry.record;
      throw err;
    });
    waiterView.catch(() => undefined); // waiters that never arrive must not surface as unhandled
    entry.inFlight = waiterView;
    return { record: await inFlight, replayed: false };
  }

  get(principal: string, key: string): IdempotencyRecord<T> | undefined {
    const k = this.key(principal, key);
    return this.live(this.entries.get(k), k)?.record;
  }

  get size(): number {
    return this.entries.size;
  }
}
