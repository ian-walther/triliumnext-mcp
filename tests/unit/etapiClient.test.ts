import { describe, expect, it } from 'vitest';
import { TriliumClient } from '../../src/etapi/client.js';
import { EtapiError } from '../../src/etapi/errors.js';

function client(
  fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>,
  extra: Partial<ConstructorParameters<typeof TriliumClient>[0]> = {},
) {
  return new TriliumClient({
    baseUrl: 'http://trilium.test/etapi',
    token: 'tok',
    fetch: fetchImpl,
    sleep: () => Promise.resolve(),
    timeoutMs: 200,
    ...extra,
  });
}

describe('TriliumClient', () => {
  it('sends the raw token and parses json', async () => {
    let seen: RequestInit | undefined;
    const c = client((_u, init) => {
      seen = init;
      return Promise.resolve(new Response(JSON.stringify({ appVersion: '1' }), { status: 200 }));
    });
    const info = await c.getAppInfo();
    expect(info.appVersion).toBe('1');
    expect((seen?.headers as Record<string, string>).authorization).toBe('tok');
  });

  it('normalizes etapi error bodies', async () => {
    const c = client(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ status: 404, code: 'NOTE_NOT_FOUND', message: "Note 'x' not found." }),
          { status: 404 },
        ),
      ),
    );
    const err = await c.getNote('xyz').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EtapiError);
    expect((err as EtapiError).status).toBe(404);
    expect((err as EtapiError).code).toBe('NOTE_NOT_FOUND');
    expect((err as EtapiError).isNotFound).toBe(true);
  });

  it('retries idempotent requests on 503 but not writes', async () => {
    let calls = 0;
    const flaky = () => {
      calls += 1;
      return Promise.resolve(
        calls < 3
          ? new Response('busy', { status: 503 })
          : new Response('{"noteId":"a"}', { status: 200 }),
      );
    };
    const c = client(flaky, { retries: 3 });
    await expect(c.getNote('a')).resolves.toEqual({ noteId: 'a' });
    expect(calls).toBe(3);
    calls = 0;
    await expect(c.createRevision('a')).rejects.toBeInstanceOf(EtapiError);
    expect(calls).toBe(1);
  });

  it('turns aborts into timeout errors', async () => {
    const c = client(
      (_u, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
      { retries: 0, timeoutMs: 20 },
    );
    const err = await c.getAppInfo().catch((e: unknown) => e);
    expect((err as EtapiError).kind).toBe('timeout');
    expect((err as EtapiError).isRetryable).toBe(true);
  });

  it('rejects malformed ids before hitting the network', async () => {
    const c = client(() => Promise.reject(new Error('should not be called')));
    await expect(c.getNote('../etc')).rejects.toThrow(/Invalid noteId/);
  });

  it('builds search query strings', async () => {
    let url = '';
    const c = client((u) => {
      url = String(u);
      return Promise.resolve(new Response('{"results":[]}', { status: 200 }));
    });
    await c.searchNotes({
      search: "#a = 'b c'",
      limit: 5,
      fastSearch: false,
      includeArchivedNotes: true,
    });
    expect(url).toBe(
      'http://trilium.test/etapi/notes?search=%23a+%3D+%27b+c%27&fastSearch=false&includeArchivedNotes=true&limit=5',
    );
  });
});
