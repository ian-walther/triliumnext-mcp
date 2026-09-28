/** Principals and scope checks shared by both transports. */
import type { Scope } from '../config.js';

export interface Principal {
  /** Stable identity for audit, rate limiting and idempotency: `client` or `client:subject`. */
  id: string;
  /** The OAuth client (azp/client_id), static token id, 'stdio', or 'anonymous'. */
  clientId: string;
  /** The user the client acts for, when the token says (OIDC `sub`). */
  subject?: string;
  scopes: Scope[];
  transport: 'stdio' | 'http';
}

export function principalId(clientId: string, subject: string | undefined): string {
  return subject && subject !== clientId ? `${clientId}:${subject}` : clientId;
}

export function hasScope(principal: Principal, scope: Scope): boolean {
  return principal.scopes.includes(scope);
}
