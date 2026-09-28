/** Domain-level regressions for the second audit pass (R2–R5). */
import { beforeEach, describe, expect, it } from 'vitest';
import { IdempotencyStore } from '../../src/domain/idempotency.js';
import { expandReplacement } from '../../src/domain/regexRunner.js';
import {
  applyEdit,
  createServices,
  type CreateNoteResult,
  type Services,
} from '../../src/domain/services.js';
import { TriliumClient, trimUtf8 } from '../../src/etapi/client.js';
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
    idempotency: new IdempotencyStore<CreateNoteResult>(),
    regexTimeoutMs: 500,
  });
  fake.addNote({ noteId: 'home', title: 'Home', type: 'book', parentNoteId: 'root' });
  fake.addNote({
    noteId: 'plumb',
    title: 'Plumbing',
    type: 'text',
    parentNoteId: 'home',
    content: '<p>Fix the sink</p>',
  });
});

const withLabel = (key: string, principal = 'p') =>
  services.notes.create({
    principal,
    parentNoteId: 'home',
    title: 'Keyed',
    idempotencyKey: key,
    attributes: [{ type: 'label', name: 'k', value: 'v' }],
  });

describe('R2 idempotent replay waits for completion and keeps outcomes', () => {
  it('a duplicate request cannot finish before the original operation', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held = false;
    fake.intercept = async (call: RecordedCall) => {
      if (call.method === 'POST' && call.path === '/attributes' && !held) {
        held = true;
        await gate;
      }
      return undefined;
    };
    const first = withLabel('key-12345678');
    await new Promise((r) => setTimeout(r, 20)); // first call is now parked inside attribute creation
    let secondDone = false;
    const second = withLabel('key-12345678').then((r) => {
      secondDone = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(secondDone).toBe(false);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(b.idempotentReplay).toBe(true);
    expect(b.note.noteId).toBe(a.note.noteId);
    expect(b.attributeResults).toEqual(a.attributeResults);
    expect(a.attributeResults[0]?.ok).toBe(true);
    expect(fake.calls.filter((c) => c.method === 'POST' && c.path === '/create-note')).toHaveLength(
      1,
    );
  });

  it('replays preserve failed attribute outcomes', async () => {
    fake.intercept = (call: RecordedCall) =>
      call.method === 'POST' && call.path === '/attributes'
        ? new Response('{"status":503,"code":"GENERIC","message":"no"}', { status: 503 })
        : undefined;
    const first = await withLabel('key-12345678');
    expect(first.attributeResults[0]?.ok).toBe(false);
    const again = await withLabel('key-12345678');
    expect(again.idempotentReplay).toBe(true);
    expect(again.attributeResults[0]?.ok).toBe(false);
    expect(again.incomplete).toBeUndefined();
  });

  it('a failure during the final read leaves an honest, non-duplicating replay', async () => {
    let failuresLeft = 0;
    fake.intercept = (call: RecordedCall) => {
      if (call.method === 'POST' && call.path === '/create-note')
        failuresLeft = 3; // the client retries GETs twice
      else if (
        failuresLeft > 0 &&
        call.method === 'GET' &&
        /^\/notes\/[^/]+$/.test(call.path) &&
        !call.path.endsWith('/home')
      ) {
        failuresLeft -= 1;
        return new Response('down', { status: 503 });
      }
      return undefined;
    };
    await expect(withLabel('key-12345678')).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    const replay = await withLabel('key-12345678');
    expect(replay.incomplete).toBe(true);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.attributeResults[0]?.ok).toBe(true);
    expect(replay.warnings.join(' ')).toMatch(
      /failed after the note was created \(UPSTREAM_UNAVAILABLE\)/,
    );
    expect(fake.calls.filter((c) => c.method === 'POST' && c.path === '/create-note')).toHaveLength(
      1,
    );
    expect(fake.calls.filter((c) => c.method === 'POST' && c.path === '/attributes')).toHaveLength(
      1,
    );
  });

  it('still rejects a different payload and isolates principals', async () => {
    await withLabel('key-12345678');
    await expect(
      services.notes.create({
        principal: 'p',
        parentNoteId: 'home',
        title: 'Keyed',
        idempotencyKey: 'key-12345678',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    const other = await services.notes.create({
      principal: 'q',
      parentNoteId: 'home',
      title: 'Keyed2',
      idempotencyKey: 'key-12345678',
    });
    expect(other.created).toBe(true);
  });
});

describe('R3 edit assembly respects the write budget', () => {
  it('returns TOO_LARGE during expansion instead of building an oversized string', async () => {
    const content = 'a'.repeat(300);
    const started = Date.now();
    await expect(
      applyEdit(content, { find: 'a', replace: 'b'.repeat(60_000), all: true }, 'e', 500, 100_000),
    ).rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect(Date.now() - started).toBeLessThan(2000);
    // context-copying tokens count too
    await expect(
      applyEdit(
        'x'.repeat(5000),
        { find: 'x', replace: "$`$'", regex: true, all: true },
        'e',
        500,
        100_000,
      ),
    ).rejects.toMatchObject({ code: 'TOO_LARGE' });
    // a bounded batch still works
    await expect(
      applyEdit('a-a', { find: 'a', replace: 'bb', all: true }, 'e', 500, 100),
    ).resolves.toBe('bb-bb');
  });

  it('stops a multi-edit patch before the second scan, revision or write', async () => {
    fake.addNote({
      noteId: 'code',
      title: 'Code',
      type: 'code',
      mime: 'text/plain',
      parentNoteId: 'home',
      content: 'a'.repeat(3000),
    });
    const before = fake.calls.length;
    await expect(
      services.notes.patch({
        noteId: 'code',
        expectedHash: fake.blobId('code'),
        operation: 'edit',
        edits: [
          { find: 'a', replace: 'b'.repeat(60_000), all: true },
          { find: 'zzz', replace: 'q' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'TOO_LARGE' });
    const after = fake.calls.slice(before);
    expect(after.some((c) => c.method === 'PUT' || /\/revision$/.test(c.path))).toBe(false);
    expect(fake.notes.get('code')?.content).toBe('a'.repeat(3000));
  });
});

describe('R4 named replacement semantics match String.prototype.replace', () => {
  const cases: Array<[string, string, string, string?]> = [
    ['abc', 'b', '$<missing>'],
    ['abc', '(?<x>b)', '[$<x>]'],
    ['abc', '(?<x>b)', '[$<y>]'],
    ['abc', '(?<x>z)?b', '[$<x>]'],
    ['abc', 'b', '$<'],
    ['abab', 'b', '$<missing>', 'g'],
  ];
  for (const [input, source, template, flags] of cases) {
    it(`"${input}".replace(/${source}/${flags ?? ''}, "${template}")`, async () => {
      const expected = input.replace(new RegExp(source, flags ?? ''), template);
      const actual = await applyEdit(
        input,
        {
          find: source,
          replace: template,
          regex: true,
          all: flags === 'g',
          ...(flags === 'g' ? {} : {}),
        },
        'e',
        500,
      );
      expect(actual).toBe(expected);
    });
  }
  it('selected occurrence and literal templates are unaffected', async () => {
    await expect(
      applyEdit('abab', { find: 'b', replace: '$<n>', regex: true, occurrence: 2 }, 'e', 500),
    ).resolves.toBe('aba$<n>');
    await expect(
      applyEdit('abab', { find: 'b', replace: '$<n>', regex: false, occurrence: 2 }, 'e', 500),
    ).resolves.toBe('aba$<n>');
    expect(
      expandReplacement('$<n>', { index: 0, length: 1, captures: ['b'], groups: null }, 'b', false),
    ).toBe('$<n>');
    expect(
      expandReplacement('$<n>', { index: 0, length: 1, captures: ['b'], groups: {} }, 'b', false),
    ).toBe('');
  });
});

describe('R5 unknown content length is not reported as zero', () => {
  const client = (headers: Record<string, string>, body: string) =>
    new TriliumClient({
      baseUrl: 'http://x/etapi',
      token: 't',
      retries: 0,
      fetch: () => Promise.resolve(new Response(body, { status: 200, headers })),
    });

  it('omits totalBytes when the header is absent or malformed and the read was truncated', async () => {
    const body = 'x'.repeat(2000);
    expect(await client({}, body).readNoteContent('n1234567', 10)).toEqual({
      content: 'xxxxxxxxxx',
      truncated: true,
    });
    expect(await client({ 'content-length': 'abc' }, body).readNoteContent('n1234567', 10)).toEqual(
      { content: 'xxxxxxxxxx', truncated: true },
    );
    expect(
      await client({ 'content-length': '2000', 'content-encoding': 'gzip' }, body).readNoteContent(
        'n1234567',
        10,
      ),
    ).toEqual({ content: 'xxxxxxxxxx', truncated: true });
  });
  it('reports the header length when truncated and the observed length when complete', async () => {
    const body = 'x'.repeat(2000);
    expect(
      await client({ 'content-length': '2000' }, body).readNoteContent('n1234567', 10),
    ).toEqual({ content: 'xxxxxxxxxx', truncated: true, totalBytes: 2000 });
    expect(await client({}, 'héllo').readNoteContent('n1234567', 100)).toEqual({
      content: 'héllo',
      truncated: false,
      totalBytes: 6,
    });
    expect(await client({ 'content-length': '0' }, '').readNoteContent('n1234567', 100)).toEqual({
      content: '',
      truncated: false,
      totalBytes: 0,
    });
  });
  it('propagates to get_note and keeps UTF-8 truncation safe', async () => {
    fake.addNote({
      noteId: 'uni',
      title: 'Uni',
      type: 'code',
      mime: 'text/plain',
      parentNoteId: 'home',
      content: 'é'.repeat(3000),
    });
    const res = await services.notes.get({ noteId: 'uni', maxContentBytes: 1025 });
    expect(res.contentTruncated).toBe(true);
    expect(res.contentBytes).toBeUndefined(); // in-memory Response carries no Content-Length
    expect(res.content).toBe('é'.repeat(512));
    expect(trimUtf8(Buffer.from('aé', 'utf8').subarray(0, 2)).toString('utf8')).toBe('a');
  });
});
