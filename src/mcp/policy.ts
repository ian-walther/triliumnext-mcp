/** Principals and scope checks shared by both transports. */
import type { Scope } from '../config.js';

export interface Principal {
  /** Stable identity for audit records (token client id, static token id, or 'stdio'). */
  id: string;
  scopes: Scope[];
  transport: 'stdio' | 'http';
}

export function hasScope(principal: Principal, scope: Scope): boolean {
  return principal.scopes.includes(scope);
}
