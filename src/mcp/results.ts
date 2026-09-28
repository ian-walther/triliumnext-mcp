/**
 * Tool result helpers. Every tool returns `structuredContent` for
 * structured-output clients and, per the MCP spec's backwards-compatibility
 * guidance, the same JSON serialized into a text block for clients that only
 * read `content`.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import { DomainError } from '../domain/errors.js';

export interface AuditMeta {
  /** Outcome code for the audit record when the call succeeded only partially. */
  code?: string;
  /** Note ids the call actually touched or produced (overrides the input-derived list). */
  noteIds?: string[];
}

const auditMetaByResult = new WeakMap<CallToolResult, AuditMeta>();

/** Attach audit facts a handler learns while running (created ids, partial failure). */
export function withAudit(result: CallToolResult, meta: AuditMeta): CallToolResult {
  auditMetaByResult.set(result, meta);
  return result;
}

export function auditMetaOf(result: CallToolResult): AuditMeta | undefined {
  return auditMetaByResult.get(result);
}

export interface ToolErrorPayload {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

export function ok<T extends object>(structured: T): CallToolResult {
  const payload = structured as unknown as Record<string, unknown>;
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
}

/**
 * Like `ok`, with extra content blocks after the JSON text block: an image
 * block so multimodal clients can look at an image attachment, or an embedded
 * resource for other binary data. `structuredContent` stays the source of truth.
 */
export function okWith<T extends object>(
  structured: T,
  extra: CallToolResult['content'],
): CallToolResult {
  const result = ok(structured);
  return { ...result, content: [...result.content, ...extra] };
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
