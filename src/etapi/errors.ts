/** Normalized errors for the ETAPI client. Nothing MCP-specific lives here. */

export type EtapiErrorKind = 'http' | 'network' | 'timeout' | 'protocol';

export class EtapiError extends Error {
  override readonly name: string = 'EtapiError';
  readonly kind: EtapiErrorKind;
  readonly status: number | undefined;
  readonly code: string;
  readonly method: string;
  readonly path: string;

  constructor(init: {
    kind: EtapiErrorKind;
    message: string;
    method: string;
    path: string;
    status?: number;
    code?: string;
    cause?: unknown;
  }) {
    super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.kind = init.kind;
    this.status = init.status;
    this.code =
      init.code ?? (init.kind === 'http' ? `HTTP_${init.status ?? 0}` : init.kind.toUpperCase());
    this.method = init.method;
    this.path = init.path;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  get isRetryable(): boolean {
    if (this.kind === 'network' || this.kind === 'timeout') return true;
    return this.status === 502 || this.status === 503 || this.status === 504;
  }
}
