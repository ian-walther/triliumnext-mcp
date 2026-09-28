/** Shared wiring for protocol tests: fake Trilium + app context + HTTP transport. */
import type { OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { createAppContext, type AppContext } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { silentLogger, type AuditEvent } from '../../src/logging/logger.js';
import { createHttpTransport, type HttpTransport } from '../../src/transport/http.js';
import { FakeTrilium } from './fakeTrilium.js';

export interface Harness {
  fake: FakeTrilium;
  ctx: AppContext;
  transport: HttpTransport;
  audit: AuditEvent[];
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  close(): Promise<void>;
}

export function seed(fake: FakeTrilium): void {
  fake.addNote({ noteId: 'projects', title: 'Projects', type: 'book', parentNoteId: 'root' });
  fake.addNote({
    noteId: 'plumb',
    title: 'Plumbing',
    type: 'text',
    parentNoteId: 'projects',
    content: '<p>Fix the sink</p>',
    labels: { status: 'todo' },
  });
  fake.addNote({
    noteId: 'garden',
    title: 'Garden',
    type: 'text',
    parentNoteId: 'projects',
    content: '<p>Plant tomatoes</p>',
  });
}

export function createHarness(
  env: NodeJS.ProcessEnv = {},
  options: { verifier?: OAuthTokenVerifier } = {},
): Harness {
  const fake = new FakeTrilium({ token: 'tok' });
  seed(fake);
  const config = loadConfig(
    {
      TRILIUM_API_TOKEN: 'tok',
      TRILIUM_API_URL: 'http://fake/etapi',
      MCP_AUDIT_ENABLED: 'true',
      ...env,
    },
    { version: '2.0.0-test' },
  );
  const audit: AuditEvent[] = [];
  const ctx = createAppContext({ config, fetch: fake.fetch, logger: silentLogger });
  ctx.audit = { record: (e) => void audit.push(e) };
  const transport = createHttpTransport(ctx, options);
  const fetchFn = (input: string | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const headers = new Headers(init?.headers);
    // A hand-built Request has no Host header; the Node adapter sets it in production.
    if (!headers.has('host')) headers.set('host', url.host);
    return Promise.resolve(transport.app.fetch(new Request(url, { ...init, headers })));
  };
  return { fake, ctx, transport, audit, fetch: fetchFn, close: () => transport.close() };
}
