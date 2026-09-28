/**
 * Typed TriliumNext ETAPI client.
 *
 * - `fetch` is injectable so unit tests run against an in-memory fake.
 * - Every call has a timeout; idempotent GETs retry on transient failures.
 * - Errors are normalized to `EtapiError`; bodies are parsed into the ETAPI
 *   `{status, code, message}` shape when present.
 * - The ETAPI token is sent as a raw `Authorization` header (Trilium's scheme).
 */
import { EtapiError } from './errors.js';
import type {
  EtapiAppInfo,
  EtapiAttribute,
  EtapiAttributePatch,
  EtapiBranch,
  EtapiCreateAttributeDef,
  EtapiCreateBranchDef,
  EtapiCreateNoteDef,
  EtapiErrorBody,
  EtapiNote,
  EtapiNotePatch,
  EtapiNoteWithBranch,
  EtapiSearchParams,
  EtapiSearchResponse,
} from './types.js';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface TriliumClientOptions {
  baseUrl: string;
  token?: string | undefined;
  timeoutMs?: number;
  retries?: number;
  fetch?: FetchLike;
  /** Sleep hook for retry backoff; tests inject a no-op. */
  sleep?: (ms: number) => Promise<void>;
  userAgent?: string;
}

export const NOTE_ID_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

export function assertEntityId(id: string, what = 'noteId'): void {
  if (!NOTE_ID_PATTERN.test(id)) {
    throw new EtapiError({
      kind: 'protocol',
      message: `Invalid ${what} "${id}": expected 1-64 characters of [A-Za-z0-9_]`,
      method: 'LOCAL',
      path: '',
      code: 'INVALID_ENTITY_ID',
    });
  }
}

interface RequestSpec {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  json?: unknown;
  body?: string | Uint8Array;
  contentType?: string;
  accept?: 'json' | 'text' | 'bytes' | 'none';
  retry?: boolean;
  /** For text reads: stop after this many bytes (the rest of the body is discarded). */
  maxBytes?: number;
}

export class TriliumClient {
  readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly userAgent: string;

  constructor(options: TriliumClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.retries = options.retries ?? 2;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.userAgent = options.userAgent ?? 'trilium-mcp';
  }

  // ---- notes -------------------------------------------------------------

  async getAppInfo(): Promise<EtapiAppInfo> {
    return await this.request<EtapiAppInfo>({ method: 'GET', path: '/app-info', retry: true });
  }

  async searchNotes(params: EtapiSearchParams): Promise<EtapiSearchResponse> {
    const query: Record<string, string | number | boolean | undefined> = {
      search: params.search,
      fastSearch: params.fastSearch,
      includeArchivedNotes: params.includeArchivedNotes,
      ancestorNoteId: params.ancestorNoteId,
      ancestorDepth: params.ancestorDepth,
      orderBy: params.orderBy,
      orderDirection: params.orderDirection,
      limit: params.limit,
      debug: params.debug,
    };
    return await this.request<EtapiSearchResponse>({
      method: 'GET',
      path: '/notes',
      query,
      retry: true,
    });
  }

  async getNote(noteId: string): Promise<EtapiNote> {
    assertEntityId(noteId);
    return await this.request<EtapiNote>({ method: 'GET', path: `/notes/${noteId}`, retry: true });
  }

  async getNoteContent(noteId: string): Promise<string> {
    assertEntityId(noteId);
    return await this.request<string>({
      method: 'GET',
      path: `/notes/${noteId}/content`,
      accept: 'text',
      retry: true,
    });
  }

  /**
   * Read note content without buffering more than `maxBytes` of it. Trilium
   * sends whole bodies; this stops reading early and cancels the stream so a
   * multi-megabyte note cannot exhaust memory on a small read.
   */
  async readNoteContent(noteId: string, maxBytes: number): Promise<BoundedText> {
    assertEntityId(noteId);
    return await this.request<BoundedText>({
      method: 'GET',
      path: `/notes/${noteId}/content`,
      accept: 'text',
      retry: true,
      maxBytes,
    });
  }

  async getNoteContentBytes(noteId: string): Promise<Uint8Array> {
    assertEntityId(noteId);
    return await this.request<Uint8Array>({
      method: 'GET',
      path: `/notes/${noteId}/content`,
      accept: 'bytes',
      retry: true,
    });
  }

  async putNoteContent(noteId: string, content: string, contentType = 'text/plain'): Promise<void> {
    assertEntityId(noteId);
    await this.request<void>({
      method: 'PUT',
      path: `/notes/${noteId}/content`,
      body: content,
      contentType,
      accept: 'none',
    });
  }

  async createNote(def: EtapiCreateNoteDef): Promise<EtapiNoteWithBranch> {
    assertEntityId(def.parentNoteId, 'parentNoteId');
    return await this.request<EtapiNoteWithBranch>({
      method: 'POST',
      path: '/create-note',
      json: def,
    });
  }

  async patchNote(noteId: string, patch: EtapiNotePatch): Promise<EtapiNote> {
    assertEntityId(noteId);
    return await this.request<EtapiNote>({
      method: 'PATCH',
      path: `/notes/${noteId}`,
      json: patch,
    });
  }

  async deleteNote(noteId: string): Promise<void> {
    assertEntityId(noteId);
    await this.request<void>({ method: 'DELETE', path: `/notes/${noteId}`, accept: 'none' });
  }

  async createRevision(noteId: string, description?: string): Promise<void> {
    assertEntityId(noteId);
    await this.request<void>({
      method: 'POST',
      path: `/notes/${noteId}/revision`,
      accept: 'none',
      ...(description !== undefined ? { json: { description } } : {}),
    });
  }

  // ---- branches ----------------------------------------------------------

  async getBranch(branchId: string): Promise<EtapiBranch> {
    assertEntityId(branchId, 'branchId');
    return await this.request<EtapiBranch>({
      method: 'GET',
      path: `/branches/${branchId}`,
      retry: true,
    });
  }

  async createBranch(def: EtapiCreateBranchDef): Promise<EtapiBranch> {
    assertEntityId(def.noteId);
    assertEntityId(def.parentNoteId, 'parentNoteId');
    return await this.request<EtapiBranch>({ method: 'POST', path: '/branches', json: def });
  }

  async patchBranch(
    branchId: string,
    patch: Partial<Pick<EtapiBranch, 'notePosition' | 'prefix' | 'isExpanded'>>,
  ): Promise<EtapiBranch> {
    assertEntityId(branchId, 'branchId');
    return await this.request<EtapiBranch>({
      method: 'PATCH',
      path: `/branches/${branchId}`,
      json: patch,
    });
  }

  async deleteBranch(branchId: string): Promise<void> {
    assertEntityId(branchId, 'branchId');
    await this.request<void>({ method: 'DELETE', path: `/branches/${branchId}`, accept: 'none' });
  }

  // ---- attributes --------------------------------------------------------

  async getAttribute(attributeId: string): Promise<EtapiAttribute> {
    assertEntityId(attributeId, 'attributeId');
    return await this.request<EtapiAttribute>({
      method: 'GET',
      path: `/attributes/${attributeId}`,
      retry: true,
    });
  }

  async createAttribute(def: EtapiCreateAttributeDef): Promise<EtapiAttribute> {
    assertEntityId(def.noteId);
    return await this.request<EtapiAttribute>({ method: 'POST', path: '/attributes', json: def });
  }

  async patchAttribute(attributeId: string, patch: EtapiAttributePatch): Promise<EtapiAttribute> {
    assertEntityId(attributeId, 'attributeId');
    return await this.request<EtapiAttribute>({
      method: 'PATCH',
      path: `/attributes/${attributeId}`,
      json: patch,
    });
  }

  async deleteAttribute(attributeId: string): Promise<void> {
    assertEntityId(attributeId, 'attributeId');
    await this.request<void>({
      method: 'DELETE',
      path: `/attributes/${attributeId}`,
      accept: 'none',
    });
  }

  // ---- core --------------------------------------------------------------

  private buildUrl(spec: RequestSpec): string {
    const url = new URL(`${this.baseUrl}${spec.path}`);
    if (spec.query) {
      for (const [k, v] of Object.entries(spec.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  private async request<T>(spec: RequestSpec): Promise<T> {
    const attempts = spec.retry ? this.retries + 1 : 1;
    let lastError: EtapiError | undefined;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await this.once<T>(spec);
      } catch (err) {
        if (!(err instanceof EtapiError) || !err.isRetryable || attempt === attempts - 1) throw err;
        lastError = err;
        await this.sleep(200 * 2 ** attempt);
      }
    }
    throw lastError ?? new Error('unreachable');
  }

  private async once<T>(spec: RequestSpec): Promise<T> {
    const url = this.buildUrl(spec);
    const headers: Record<string, string> = { 'user-agent': this.userAgent };
    if (this.token) headers.authorization = this.token;
    const accept = spec.accept ?? 'json';
    if (accept === 'json') headers.accept = 'application/json';
    let body: RequestInit['body'] | undefined;
    if (spec.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(spec.json);
    } else if (spec.body !== undefined) {
      headers['content-type'] = spec.contentType ?? 'application/octet-stream';
      body = spec.body;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const transportError = (cause: unknown): EtapiError => {
      const aborted = controller.signal.aborted;
      return new EtapiError({
        kind: aborted ? 'timeout' : 'network',
        message: aborted
          ? `Trilium request timed out after ${this.timeoutMs}ms: ${spec.method} ${spec.path}`
          : `Trilium request failed: ${spec.method} ${spec.path}: ${describeCause(cause)}`,
        method: spec.method,
        path: spec.path,
        cause,
      });
    };
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: spec.method,
          headers,
          signal: controller.signal,
          ...(body !== undefined ? { body } : {}),
        });
      } catch (cause) {
        throw transportError(cause);
      }
      // Body consumption can also time out or fail mid-stream; normalize those too.
      try {
        if (!response.ok) {
          throw await this.toHttpError(response, spec);
        }
        if (accept === 'none' || response.status === 204) {
          await response.arrayBuffer().catch(() => undefined);
          return undefined as T;
        }
        if (accept === 'text') {
          if (spec.maxBytes !== undefined) {
            return (await readTextBounded(response, spec.maxBytes)) as T;
          }
          return (await response.text()) as T;
        }
        if (accept === 'bytes') return new Uint8Array(await response.arrayBuffer()) as T;
        const text = await response.text();
        if (text === '') return undefined as T;
        try {
          return JSON.parse(text) as T;
        } catch (cause) {
          throw new EtapiError({
            kind: 'protocol',
            message: `Trilium returned non-JSON for ${spec.method} ${spec.path}`,
            method: spec.method,
            path: spec.path,
            status: response.status,
            code: 'INVALID_JSON',
            cause,
          });
        }
      } catch (cause) {
        if (cause instanceof EtapiError) throw cause;
        throw transportError(cause);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async toHttpError(response: Response, spec: RequestSpec): Promise<EtapiError> {
    let parsed: Partial<EtapiErrorBody> | undefined;
    let raw = '';
    try {
      raw = await response.text();
      const json = JSON.parse(raw) as unknown;
      if (json && typeof json === 'object') parsed = json;
    } catch {
      /* body was not JSON */
    }
    const message =
      parsed?.message ??
      (raw ? raw.slice(0, 300) : `${response.status} ${response.statusText}`.trim());
    return new EtapiError({
      kind: 'http',
      status: response.status,
      code: parsed?.code ?? `HTTP_${response.status}`,
      message: `Trilium ${spec.method} ${spec.path} failed (${response.status}): ${message}`,
      method: spec.method,
      path: spec.path,
    });
  }
}

export interface BoundedText {
  content: string;
  truncated: boolean;
  /** Total body size when known (Content-Length, or the bytes read when not truncated). */
  totalBytes?: number;
}

/** Trim a byte buffer to the last complete UTF-8 sequence. */
export function trimUtf8(buf: Buffer): Buffer {
  const end = buf.length;
  let i = end - 1;
  // Walk back over continuation bytes to find the lead byte of the last sequence.
  while (i >= 0 && i >= end - 4 && (buf[i]! & 0xc0) === 0x80) i--;
  if (i < 0) return buf.subarray(0, 0);
  const lead = buf[i]!;
  const needed = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return end - i >= needed ? buf : buf.subarray(0, i);
}

async function readTextBounded(response: Response, maxBytes: number): Promise<BoundedText> {
  // Content-Length is only meaningful when present, numeric, and describing the
  // decoded body (no content-encoding). Number(null) would be 0, so parse explicitly.
  const declaredRaw = response.headers.get('content-length');
  const encoding = response.headers.get('content-encoding');
  const totalFromHeader =
    declaredRaw !== null && /^\d+$/.test(declaredRaw) && (!encoding || encoding === 'identity')
      ? Number(declaredRaw)
      : undefined;
  if (!response.body) {
    const text = await response.text();
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length <= maxBytes)
      return { content: text, truncated: false, totalBytes: bytes.length };
    return {
      content: trimUtf8(bytes.subarray(0, maxBytes)).toString('utf8'),
      truncated: true,
      totalBytes: bytes.length,
    };
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = (await reader.read()) as { done: boolean; value?: Uint8Array };
      if (done || value === undefined) break;
      const chunk: Buffer = Buffer.from(value);
      if (received + chunk.length > maxBytes) {
        chunks.push(chunk.subarray(0, maxBytes - received));
        received = maxBytes;
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(chunk);
      received += chunk.length;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes: Buffer = Buffer.concat(chunks);
  return {
    content: (truncated ? trimUtf8(bytes) : bytes).toString('utf8'),
    truncated,
    ...(truncated
      ? totalFromHeader !== undefined
        ? { totalBytes: totalFromHeader }
        : {}
      : { totalBytes: bytes.length }),
  };
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    const inner = (cause as Error & { cause?: unknown }).cause;
    if (inner instanceof Error && inner.message) return `${cause.message} (${inner.message})`;
    return cause.message;
  }
  return String(cause);
}
