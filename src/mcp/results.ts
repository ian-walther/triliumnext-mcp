/**
 * Tool result helpers. Every tool returns `structuredContent` for
 * structured-output clients and, per the MCP spec's backwards-compatibility
 * guidance, the same JSON serialized into a text block for clients that only
 * read `content`.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import { DomainError } from '../domain/errors.js';

export interface ToolErrorPayload {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

export function ok<T extends object>(structured: T): CallToolResult {
  const payload = structured as unknown as Record<string, unknown>;
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
}

export function fail(err: unknown, context?: string): CallToolResult {
  const domain = DomainError.from(err, context);
  const payload: ToolErrorPayload = {
    error: {
      code: domain.code,
      message: domain.message,
      ...(Object.keys(domain.details).length ? { details: domain.details } : {}),
    },
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}
