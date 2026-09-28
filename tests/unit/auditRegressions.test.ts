/**
 * Regression tests for the findings in AUDIT.md (domain level). Each block names
 * the finding it guards. HTTP-level regressions live in tests/protocol.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DomainError } from '../../src/domain/errors.js';
import { IdempotencyStore } from '../../src/domain/idempotency.js';
import { KeyedMutex } from '../../src/domain/keyedMutex.js';
import { expandReplacement, scanRegex } from '../../src/domain/regexRunner.js';
import {
  applyEdit,
  createServices,
  findInContent,
  type Services,
} from '../../src/domain/services.js';
import { TriliumClient } from '../../src/etapi/client.js';
import { EtapiError } from '../../src/etapi/errors.js';
import { createAuditLog, createLogger } from '../../src/logging/logger.js';
import { FakeTrilium, type RecordedCall } from '../helpers/fakeTrilium.js';

const limits = {
  maxWriteContentBytes: 100_000,
  defaultReadContentBytes: 10_000,
  maxReadContentBytes: 50_000,
  maxSearchLimit: 100,
  maxChildren: 100,
};

let fake: FakeTrilium;
let services: Services;

beforeEach(() => {
  fake = new FakeTrilium({ token: 'tok' });
  const client = new TriliumClient({
    baseUrl: 'http://fake/etapi',
    token: 'tok',
    fetch: fake.fetch,
    sleep: () => Promise.resolve(),
  });
  services = createServices({
    client,
    limits,
    idempotency: new IdempotencyStore(),
    regexTimeoutMs: 500,
    ascendingWindow: 50,
  });
  fake.addNote({ noteId: 'home', title: 'Home', type: 'book', parentNoteId: 'root' });
  fake.addNote({
    noteId: 'plumb',
    title: 'Plumbing',
    type: 'text',
    parentNoteId: 'home',
    content: '<p>Fix the sink</p>',
  });
  fake.addNote({
    noteId: 'garden',
    title: 'Garden',
    type: 'text',
    parentNoteId: 'home',
    content: '<p>Plant tomatoes</p>',
  });
});

describe('F02 concurrent patches', () => {
  it('serializes same-hash writes: one succeeds, the other gets CONFLICT, nothing is lost', async () => {
    const hash = fake.blobId('plumb');
    const settled = await Promise.allSettled([
      services.notes.patch({
        noteId: 'plumb',
        expectedHash: hash,
        operation: 'append',
        content: 'A',
      }),
      services.notes.patch({
        noteId: 'plumb',
        expectedHash: hash,
        operation: 'append',
        content: 'B',
      }),
    ]);
    const ok = settled.filter((r) => r.status === 'fulfilled');
    const failed = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0]!.reason as DomainError).code).toBe('CONFLICT');
    const content = fake.notes.get('plumb')!.content;
    expect(content).toBe(`<p>Fix the sink</p>\n<p>${content.includes('<p>A</p>') ? 'A' : 'B'}</p>`);
  });

  it('KeyedMutex runs same-key sections in order and different keys concurrently', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    const slow = (key: string, label: string, ms: number) =>
      mutex.run(key, async () => {
        order.push(`${label}:start`);
        await new Promise((r) => setTimeout(r, ms));
        order.push(`${label}:end`);
      });
    await Promise.all([slow('a', 'a1', 20), slow('a', 'a2', 1), slow('b', 'b1', 1)]);
    expect(order.indexOf('a2:start')).toBeGreaterThan(order.indexOf('a1:end'));
    expect(order.indexOf('b1:start')).toBeLessThan(order.indexOf('a1:end'));
    expect(mutex.pending).toBe(0);
  });
});

describe('F03 idempotent creates', () => {
  const create = (key: string, extra: Record<string, unknown> = {}, principal = 'p') =>
    services.notes.create({
      principal,
      parentNoteId: 'home',
      title: 'Once',
      idempotencyKey: key,
      ...extra,
    });

  it('coalesces concurrent identical requests onto one upstream create', async () => {
    const [a, b, c] = await Promise.all([
      create('key-12345678'),
      create('key-12345678'),
      create('key-12345678'),
    ]);
    expect(new Set([a.note.noteId, b.note.noteId, c.note.noteId]).size).toBe(1);
    expect([a, b, c].filter((r) => r.created)).toHaveLength(1);
    expect([a, b, c].filter((r) => r.idempotentReplay)).toHaveLength(2);
    expect(
      fake.calls.filter((call) => call.method === 'POST' && call.path === '/create-note'),
    ).toHaveLength(1);
  });

  it('rejects a key reused with a different payload', async () => {
    await create('key-12345678');
    await expect(create('key-12345678', { content: 'different' })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('remembers the note when the operation fails after the upstream create', async () => {
    let injected = false;
    fake.intercept = (call: RecordedCall) => {
      if (!injected && call.method === 'POST' && call.path === '/attributes') {
        injected = true;
        return new Response('{"status":503,"code":"GENERIC","message":"boom"}', { status: 503 });
      }
      return undefined;
    };
    const first = await create('key-12345678', { attributes: [{ type: 'label', name: 'a' }] });
    expect(first.attributeResults[0]?.ok).toBe(false);
    const again = await create('key-12345678', { attributes: [{ type: 'label', name: 'a' }] });
    expect(again.idempotentReplay).toBe(true);
    expect(again.note.noteId).toBe(first.note.noteId);
    expect(
      fake.calls.filter((call) => call.method === 'POST' && call.path === '/create-note'),
    ).toHaveLength(1);
  });

  it('retries after a failed upstream create instead of caching the failure', async () => {
    let failOnce = true;
    fake.intercept = (call: RecordedCall) => {
      if (failOnce && call.method === 'POST' && call.path === '/create-note') {
        failOnce = false;
        return new Response('{"status":503,"code":"GENERIC","message":"boom"}', { status: 503 });
      }
      return undefined;
    };
    await expect(create('key-12345678')).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    const second = await create('key-12345678');
    expect(second.created).toBe(true);
  });

  it('isolates keys per principal and serializes duplicate-title checks', async () => {
    const [a, b] = await Promise.all([
      services.notes
        .create({ principal: 'p', parentNoteId: 'home', title: 'Twin' })
        .catch((e: unknown) => e),
      services.notes
        .create({ principal: 'p', parentNoteId: 'home', title: 'Twin' })
        .catch((e: unknown) => e),
    ]);
    const codes = [a, b].map((r) => (r instanceof DomainError ? r.code : 'ok')).sort();
    expect(codes).toEqual(['DUPLICATE', 'ok']);
    const other = await create('key-12345678', {}, 'q');
    const mine = await create('key-12345678', { ifTitleExists: 'create' });
    expect(other.note.noteId).not.toBe(mine.note.noteId);
  });
});

describe('F04 regex execution bounds', () => {
  it('does not loop on zero-length matches inside surrogate pairs', async () => {
    const res = await findInContent('😀a😀', { pattern: '(?=.)', regex: true, flags: 'u' }, 500);
    expect(res.total).toBe(0);
    const scan = await scanRegex({
      content: '😀😀',
      source: '',
      flags: 'u',
      maxMatches: 5,
      timeoutMs: 500,
    });
    expect(scan.sawEmptyMatch).toBe(true);
  });

  it('terminates catastrophic backtracking within the budget', async () => {
    const started = Date.now();
    await expect(
      findInContent('a'.repeat(30) + '!', { pattern: '(a+)+$', regex: true }, 300),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(Date.now() - started).toBeLessThan(3000);
    await expect(
      applyEdit('a'.repeat(30) + '!', { find: '(a+)+$', replace: 'x', regex: true }, 'e', 300),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects invalid patterns and flags before spawning a worker', async () => {
    await expect(findInContent('x', { pattern: '(', regex: true })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    await expect(findInContent('x', { pattern: 'a', flags: 'z' })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });
});

describe('F05 revision failure', () => {
  it('refuses to write when the requested revision cannot be created', async () => {
    fake.intercept = (call: RecordedCall) =>
      call.method === 'POST' && /\/revision$/.test(call.path)
        ? new Response('{"status":500,"code":"GENERIC","message":"no"}', { status: 500 })
        : undefined;
    const before = fake.notes.get('plumb')!.content;
    await expect(
      services.notes.patch({
        noteId: 'plumb',
        expectedHash: fake.blobId('plumb'),
        operation: 'replace',
        content: 'x',
      }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    expect(fake.notes.get('plumb')!.content).toBe(before);
    const skipped = await services.notes.patch({
      noteId: 'plumb',
      expectedHash: fake.blobId('plumb'),
      operation: 'replace',
      content: 'x',
      createRevision: false,
    });
    expect(skipped.revisionCreated).toBe(false);
    expect(fake.notes.get('plumb')!.content).toBe('<p>x</p>');
  });
});

describe('F06 bounded reads', () => {
  it('caps match and context payloads and reads only the requested window', async () => {
    fake.addNote({
      noteId: 'big',
      title: 'Big',
      type: 'code',
      mime: 'text/plain',
      parentNoteId: 'home',
      content: 'x'.repeat(200_000),
    });
    const res = await services.notes.get({
      noteId: 'big',
      maxContentBytes: 1024,
      find: { pattern: 'x+', regex: true },
    });
    expect(res.contentTruncated).toBe(true);
    expect(res.content?.length).toBe(1024);
    expect(res.matches?.[0]?.match.length).toBe(500);
    expect(res.matches?.[0]?.matchTruncated).toBe(true);
    expect(res.matches?.[0]?.length).toBe(1024);
    expect(res.matches?.[0]?.context.length).toBeLessThan(700);
  });

  it('rejects absurd cursors before calling upstream', async () => {
    const cursor = Buffer.from('o:999999999').toString('base64url');
    const calls = fake.calls.length;
    await expect(services.search.search({ text: 'x', cursor })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    await expect(
      services.search.search({ text: 'x', cursor: Buffer.from('o:-1').toString('base64url') }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(fake.calls.length).toBe(calls);
  });

  it('refuses to patch notes larger than the write limit', async () => {
    fake.addNote({
      noteId: 'huge',
      title: 'Huge',
      type: 'code',
      mime: 'text/plain',
      parentNoteId: 'home',
      content: 'y'.repeat(limits.maxWriteContentBytes + 10),
    });
    await expect(
      services.notes.patch({
        noteId: 'huge',
        expectedHash: fake.blobId('huge'),
        operation: 'append',
        content: 'z',
      }),
    ).rejects.toMatchObject({ code: 'TOO_LARGE' });
  });
});

describe('F07 ascending pagination', () => {
  it('pages a fixed window without repeats and flags results beyond it', async () => {
    fake.addNote({ noteId: 'many', title: 'Many', type: 'book', parentNoteId: 'root' });
    for (let i = 1; i <= 70; i++)
      fake.addNote({
        noteId: `n${String(i).padStart(4, '0')}`,
        title: `t${String(i).padStart(4, '0')}`,
        parentNoteId: 'many',
      });
    const criteria = [{ type: 'noteProperty' as const, property: 'parents.noteId', value: 'many' }];
    const seen: string[] = [];
    let cursor: string | undefined;
    let truncated = false;
    for (let page = 0; page < 300; page++) {
      const res = await services.search.search({
        criteria,
        orderBy: 'title',
        orderDirection: 'asc',
        limit: 5,
        cursor,
      });
      seen.push(...res.items.map((n) => n.noteId));
      if (res.truncated) truncated = true;
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(50);
    expect(seen[0]).toBe('n0021'); // ascending within the 50 highest titles
    expect(seen.at(-1)).toBe('n0070');
    expect(truncated).toBe(true);
    expect(
      Math.max(
        ...fake.calls.filter((c) => c.path === '/notes').map((c) => Number(c.query['limit'])),
      ),
    ).toBe(51);
  });
});

describe('F08 replacement semantics', () => {
  it('uses the original match context for lookarounds, captures and specials', async () => {
    await expect(
      applyEdit('foobar', { find: 'foo(?=bar)', replace: 'X', regex: true }, 'e'),
    ).resolves.toBe('Xbar');
    await expect(
      applyEdit('foobar', { find: '(?<=foo)bar', replace: 'Y', regex: true }, 'e'),
    ).resolves.toBe('fooY');
    await expect(
      applyEdit('a1 b2', { find: '(\\w)(\\d)', replace: '$2$1', regex: true, all: true }, 'e'),
    ).resolves.toBe('1a 2b');
    await expect(
      applyEdit(
        'key=val',
        { find: '(?<k>\\w+)=(?<v>\\w+)', replace: '$<v>=$<k>', regex: true },
        'e',
      ),
    ).resolves.toBe('val=key');
    await expect(applyEdit('abc', { find: 'b', replace: '[$&]', regex: true }, 'e')).resolves.toBe(
      'a[b]c',
    );
    await expect(
      applyEdit('abc', { find: 'b', replace: '$1 $&', regex: false }, 'e'),
    ).resolves.toBe('a$1 $&c');
    await expect(applyEdit('x^y', { find: '^y', replace: 'Z', regex: false }, 'e')).resolves.toBe(
      'xZ',
    );
  });

  it('expandReplacement follows String.prototype.replace rules', () => {
    const m = { index: 1, length: 2, captures: ['bc', 'b', 'c'] };
    expect(expandReplacement("$$-$&-$`-$'-$1$2-$9", m, 'abcd', false)).toBe('$-bc-a-d-bc-$9');
    expect(
      expandReplacement('$12', { index: 0, length: 1, captures: ['a', 'a'] }, 'a', false),
    ).toBe('a2');
  });
});

describe('F09 audit sink and outcomes', () => {
  it('emits audit records regardless of the diagnostic log level', () => {
    const logLines: string[] = [];
    const auditLines: string[] = [];
    const logger = createLogger({ level: 'warn', sink: (l) => logLines.push(l) });
    const audit = createAuditLog({ enabled: true, logger, sink: (l) => auditLines.push(l) });
    audit.record({
      principal: 'p',
      client: 'c',
      transport: 'http',
      tool: 'get_note',
      noteIds: ['n'],
      ok: true,
      durationMs: 1,
    });
    expect(auditLines).toHaveLength(1);
    expect(JSON.parse(auditLines[0]!)).toMatchObject({
      type: 'audit',
      client: 'c',
      principal: 'p',
    });
    expect(logLines).toHaveLength(0);
  });
});

describe('F13 incomplete hierarchy reads', () => {
  it('fails on non-404 child fetch errors and reports vanished ids', async () => {
    fake.intercept = (call: RecordedCall) =>
      call.path === '/notes/garden' ? new Response('down', { status: 503 }) : undefined;
    await expect(services.notes.context({ noteId: 'home' })).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
    fake.intercept = (call: RecordedCall) =>
      call.path === '/notes/garden'
        ? new Response('{"status":404,"code":"NOTE_NOT_FOUND","message":"gone"}', { status: 404 })
        : undefined;
    const ctx = await services.notes.context({ noteId: 'home' });
    expect(ctx.children.map((c) => c.noteId)).toEqual(['plumb']);
    expect(ctx.unavailableNoteIds).toEqual(['garden']);
    expect(ctx.totalChildren).toBe(2);
  });

  it('marks preview failures per child instead of silently omitting them', async () => {
    fake.intercept = (call: RecordedCall) =>
      call.path === '/notes/garden/content' ? new Response('down', { status: 503 }) : undefined;
    const ctx = await services.notes.context({ noteId: 'home', includeChildContent: true });
    expect(ctx.children.find((c) => c.noteId === 'garden')?.previewOmittedReason).toBe(
      'UPSTREAM_UNAVAILABLE',
    );
    expect(ctx.children.find((c) => c.noteId === 'plumb')?.contentPreview).toBe('Fix the sink');
  });

  it('does not cache a transient failure to load built-in templates', async () => {
    let fail = true;
    fake.intercept = (call: RecordedCall) =>
      fail && call.path === '/notes/_templates' ? new Response('down', { status: 503 }) : undefined;
    await expect(
      services.notes.create({
        principal: 'p',
        parentNoteId: 'home',
        title: 'B1',
        type: 'book',
        attributes: [{ type: 'relation', name: 'template', value: 'Board' }],
      }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    fail = false;
    const ok = await services.notes.create({
      principal: 'p',
      parentNoteId: 'home',
      title: 'B2',
      type: 'book',
      attributes: [{ type: 'relation', name: 'template', value: 'Board' }],
    });
    expect(ok.attributeResults[0]?.ok).toBe(true);
  });
});

describe('F14 response-body failures', () => {
  it('normalizes a body that aborts mid-stream and retries GETs', async () => {
    let attempts = 0;
    const brokenBody = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"noteId":'));
          controller.error(Object.assign(new Error('socket reset'), { name: 'AbortError' }));
        },
      });
    const client = new TriliumClient({
      baseUrl: 'http://x/etapi',
      token: 't',
      retries: 2,
      sleep: () => Promise.resolve(),
      fetch: () => {
        attempts += 1;
        return Promise.resolve(
          attempts < 3
            ? new Response(brokenBody(), { status: 200 })
            : new Response('{"noteId":"a"}', { status: 200 }),
        );
      },
    });
    await expect(client.getNote('a')).resolves.toEqual({ noteId: 'a' });
    expect(attempts).toBe(3);
    attempts = 0;
    const single = new TriliumClient({
      baseUrl: 'http://x/etapi',
      token: 't',
      retries: 0,
      fetch: () => Promise.resolve(new Response(brokenBody(), { status: 200 })),
    });
    const err = await single.getNote('a').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EtapiError);
    expect((err as EtapiError).kind).toBe('network');
  });
});
