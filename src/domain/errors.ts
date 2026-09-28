/**
 * Domain error model. Tool handlers translate these into `isError` results
 * with a stable machine-readable `code` so agents can branch on them.
 */
import { EtapiError } from '../etapi/errors.js';

export type DomainErrorCode =
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'VALIDATION'
  | 'AMBIGUOUS'
  | 'DUPLICATE'
  | 'PROTECTED'
  | 'UNSUPPORTED'
  | 'TOO_LARGE'
  | 'PERMISSION'
  | 'UPSTREAM'
  | 'UPSTREAM_UNAVAILABLE'
  | 'INTERNAL';

export class DomainError extends Error {
  override readonly name: string = 'DomainError';
  readonly code: DomainErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: DomainErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.code = code;
    this.details = details;
  }

  static notFound(what: string, id: string): DomainError {
    return new DomainError('NOT_FOUND', `${what} '${id}' not found`, { id });
  }

  static validation(message: string, details: Record<string, unknown> = {}): DomainError {
    return new DomainError('VALIDATION', message, details);
  }

  /** Map any thrown value into a DomainError without losing the ETAPI detail. */
  static from(err: unknown, context?: string): DomainError {
    if (err instanceof DomainError) return err;
    if (err instanceof EtapiError) {
      const prefix = context ? `${context}: ` : '';
      if (err.status === 404)
        return new DomainError(
          'NOT_FOUND',
          `${prefix}${err.message}`,
          { etapiCode: err.code },
          err,
        );
      if (err.code === 'NOTE_IS_PROTECTED')
        return new DomainError(
          'PROTECTED',
          `${prefix}${err.message}`,
          { etapiCode: err.code },
          err,
        );
      if (err.status === 400)
        return new DomainError(
          'VALIDATION',
          `${prefix}${err.message}`,
          { etapiCode: err.code },
          err,
        );
      if (err.status === 401 || err.status === 403) {
        return new DomainError(
          'UPSTREAM',
          `${prefix}Trilium rejected the server's ETAPI token (${err.status}). Check TRILIUM_API_TOKEN.`,
          { etapiCode: err.code },
          err,
        );
      }
      if (
        err.kind === 'network' ||
        err.kind === 'timeout' ||
        (err.status !== undefined && err.status >= 500)
      ) {
        return new DomainError(
          'UPSTREAM_UNAVAILABLE',
          `${prefix}${err.message}`,
          { etapiCode: err.code, kind: err.kind },
          err,
        );
      }
      return new DomainError('UPSTREAM', `${prefix}${err.message}`, { etapiCode: err.code }, err);
    }
    const message = err instanceof Error ? err.message : String(err);
    return new DomainError('INTERNAL', context ? `${context}: ${message}` : message, {}, err);
  }
}
