/**
 * In-memory idempotency store for create operations. A retry that carries the
 * same key within the TTL gets the original result instead of a second note.
 * Process-local by design; the deployment docs cover the multi-node caveat.
 */
export interface IdempotencyRecord {
  noteId: string;
  contentHash: string;
  createdAt: number;
}

export class IdempotencyStore {
  private readonly entries = new Map<string, IdempotencyRecord>();
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

  get(principal: string, key: string): IdempotencyRecord | undefined {
    const record = this.entries.get(this.key(principal, key));
    if (!record) return undefined;
    if (this.now() - record.createdAt > this.ttlMs) {
      this.entries.delete(this.key(principal, key));
      return undefined;
    }
    return record;
  }

  set(principal: string, key: string, record: Omit<IdempotencyRecord, 'createdAt'>): void {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(this.key(principal, key), { ...record, createdAt: this.now() });
  }

  get size(): number {
    return this.entries.size;
  }
}
