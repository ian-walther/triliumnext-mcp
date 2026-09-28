/** Domain-level regressions for the second audit pass (R2–R5). */
import { beforeEach, describe, expect, it } from 'vitest';
import { IdempotencyStore } from '../../src/domain/idempotency.js';
import { expandReplacement, expandReplacementInto } from '../../src/domain/regexRunner.js';
import {
  applyEdit,
  createServices,
  MAX_REPLACEMENT_WORK,
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
    expect(res.contentBytes).toBe(6000); // the fake, like Trilium, sends Content-Length (3000 × 2 bytes)
    expect(res.content).toBe('é'.repeat(512));
    expect(trimUtf8(Buffer.from('aé', 'utf8').subarray(0, 2)).toString('utf8')).toBe('a');
  });
});

describe('R3 (pass 3) a single replacement expands under the budget', () => {
  it('stops token expansion before materializing oversized output', () => {
    const match = { index: 0, length: 60, captures: ['x'.repeat(60)] };
    const pieces: string[] = [];
    let bytes = 0;
    expect(() =>
      expandReplacementInto('$&'.repeat(600), match, 'x'.repeat(60), false, (piece) => {
        bytes += Buffer.byteLength(piece, 'utf8');
        if (bytes > 100) throw new Error('budget');
        pieces.push(piece);
      }),
    ).toThrow('budget');
    expect(pieces.length).toBeLessThanOrEqual(2); // never got past the second token
    const multibyte = { index: 0, length: 2, captures: ['éé'] };
    let seen = 0;
    expect(() =>
      expandReplacementInto(
        "$1$&$`$'x$<n>",
        { ...multibyte, captures: ['éé', 'é'], groups: { n: 'ñ' } },
        'aééb',
        false,
        (p) => {
          seen += Buffer.byteLength(p, 'utf8');
          if (seen > 6) throw new Error('budget');
        },
      ),
    ).toThrow('budget');
  });

  it('patch_note reports TOO_LARGE for a huge single expansion without a revision or write', async () => {
    fake.addNote({
      noteId: 'mega',
      title: 'Mega',
      type: 'code',
      mime: 'text/plain',
      parentNoteId: 'home',
      content: 'a'.repeat(50_000),
    });
    const before = fake.calls.length;
    await expect(
      services.notes.patch({
        noteId: 'mega',
        expectedHash: fake.blobId('mega'),
        operation: 'edit',
        edits: [{ find: 'a+', replace: '$&'.repeat(600), regex: true }],
      }),
    ).rejects.toMatchObject({ code: 'TOO_LARGE' });
    const after = fake.calls.slice(before);
    expect(after.some((c) => c.method === 'PUT' || /\/revision$/.test(c.path))).toBe(false);
    expect(fake.notes.get('mega')?.content).toBe('a'.repeat(50_000));
    // ordinary expansions still work
    await expect(
      applyEdit('abc', { find: 'b', replace: '[$&$&]', regex: true }, 'e', 500, 100),
    ).resolves.toBe('a[bb]c');
  });
});

describe('R4 (pass 3) named captures never read inherited properties', () => {
  for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
    it(`$<${name}> with another named group present → native result`, async () => {
      const expected = 'abc'.replace(/(?<x>b)/, `$<${name}>`);
      expect(expected).toBe('ac');
      await expect(
        applyEdit('abc', { find: '(?<x>b)', replace: `$<${name}>`, regex: true }, 'e', 500),
      ).resolves.toBe(expected);
    });
  }
  it('explicitly declared groups with those names substitute their own captures', async () => {
    await expect(
      applyEdit('abc', { find: '(?<toString>b)', replace: '[$<toString>]', regex: true }, 'e', 500),
    ).resolves.toBe('a[b]c');
    await expect(
      applyEdit(
        'abc',
        { find: '(?<constructor>b)', replace: '[$<constructor>]', regex: true },
        'e',
        500,
      ),
    ).resolves.toBe('a[b]c');
    expect(
      expandReplacement(
        '$<toString>',
        { index: 0, length: 1, captures: ['b'], groups: { x: 'b' } },
        'b',
        false,
      ),
    ).toBe('');
  });
  it('tool-level: the stored content matches native replacement', async () => {
    fake.addNote({
      noteId: 'abc',
      title: 'ABC',
      type: 'code',
      mime: 'text/plain',
      parentNoteId: 'home',
      content: 'abc',
    });
    const res = await services.notes.patch({
      noteId: 'abc',
      expectedHash: fake.blobId('abc'),
      operation: 'edit',
      edits: [{ find: '(?<x>b)', replace: '$<toString>', regex: true }],
    });
    expect(fake.notes.get('abc')?.content).toBe('ac');
    expect(res.editsApplied).toBe(1);
  });
});

describe('R7 / R4 (pass 4) replacement templates parse linearly and match native semantics', () => {
  const tokens = [
    '$$',
    '$&',
    '$`',
    "$'",
    '$1',
    '$2',
    '$0',
    '$10',
    '$12',
    '$<x>',
    '$<y>',
    '$<',
    '>',
    'a',
    '$',
    '$<$&>',
    '$<toString>',
  ];
  const patterns: Array<[RegExp, string]> = [
    [/b/, 'abc'],
    [/(b)/, 'abc'],
    [/(?<x>b)/, 'abc'],
    [/(b)(c)/, 'abcd'],
    [/(?<x>b)(?<y>z)?/, 'abc'],
  ];
  const toMatch = (re: RegExp, input: string) => {
    const m = re.exec(input)!;
    return {
      index: m.index,
      length: m[0].length,
      captures: Array.from(m),
      groups: m.groups ? { ...m.groups } : null,
    };
  };
  const expand = (re: RegExp, input: string, template: string) => {
    const m = toMatch(re, input);
    return (
      input.slice(0, m.index) +
      expandReplacement(template, m, input, false) +
      input.slice(m.index + m.length)
    );
  };

  it('agrees with String.prototype.replace on a seeded corpus of token combinations', () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 3000; i++) {
      const n = 1 + Math.floor(rnd() * 5);
      let t = '';
      for (let j = 0; j < n; j++) t += tokens[Math.floor(rnd() * tokens.length)];
      for (const [re, input] of patterns)
        expect(expand(re, input, t), `${re.source} :: ${t}`).toBe(input.replace(re, t));
    }
  });

  it('handles malformed named-capture syntax like JavaScript, with and without named groups', () => {
    const cases = [
      '$<$&>',
      '$<$$>',
      "$<$`$'>",
      '$<$1>',
      '$<a$<b>c',
      '$<',
      '$<x',
      '$<x>$<',
      '>$<x>',
      '$<>',
      '$<toString>$&',
      '$$<x>',
    ];
    for (const t of cases) {
      for (const [re, input] of patterns)
        expect(expand(re, input, t), `${re.source} :: ${t}`).toBe(input.replace(re, t));
    }
    expect(expand(/b/, 'abc', '$<$&>')).toBe('a$<b>c');
    expect(expand(/(?<x>b)/, 'abc', '$<$&>')).toBe('ac'); // unknown name "$&" with groups present → empty
  });

  it('does not rescan the suffix for each unterminated "$<" (linear time)', () => {
    const big = '$<'.repeat(100_000); // the maximum the tool schema allows
    const named = toMatch(/(?<x>b)/, 'abc');
    const unnamed = toMatch(/b/, 'abc');
    const time = (fn: () => string) => {
      const t0 = performance.now();
      const out = fn();
      return { ms: performance.now() - t0, out };
    };
    const small = time(() => expandReplacement('$<'.repeat(10_000), named, 'abc', false));
    const large = time(() => expandReplacement(big, named, 'abc', false));
    expect(large.out).toBe('abc'.replace(/(?<x>b)/, big).slice(1, -1));
    expect(time(() => expandReplacement(big, unnamed, 'abc', false)).out).toBe(
      'abc'.replace(/b/, big).slice(1, -1),
    );
    // Generous bounds: the quadratic version took seconds; linear takes milliseconds.
    expect(large.ms).toBeLessThan(500);
    expect(large.ms).toBeLessThan(Math.max(50, small.ms * 40));
  });

  it('tool-level: stores native results for "$<$&>" and for the maximum unterminated template', async () => {
    fake.addNote({
      noteId: 'r4',
      title: 'R4',
      type: 'code',
      mime: 'text/plain',
      parentNoteId: 'home',
      content: 'abc',
    });
    await services.notes.patch({
      noteId: 'r4',
      expectedHash: fake.blobId('r4'),
      operation: 'edit',
      edits: [{ find: 'b', replace: '$<$&>', regex: true }],
    });
    expect(fake.notes.get('r4')?.content).toBe('a$<b>c');
    fake.addNote({
      noteId: 'r7',
      title: 'R7',
      type: 'code',
      mime: 'text/plain',
      parentNoteId: 'home',
      content: 'abc',
    });
    // 80 000 characters: below this fixture's 100 000-byte write limit (the helper test covers the schema maximum).
    const big = '$<'.repeat(40_000);
    const t0 = performance.now();
    await services.notes.patch({
      noteId: 'r7',
      expectedHash: fake.blobId('r7'),
      operation: 'edit',
      edits: [{ find: '(?<x>b)', replace: big, regex: true }],
    });
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(fake.notes.get('r7')?.content).toBe('abc'.replace(/(?<x>b)/, big));
  });
});

describe('R8 (pass 5) aggregate replacement work is budgeted', () => {
  /** Measures the longest event-loop stall while `fn` runs. */
  async function withLoopWatch<T>(fn: () => Promise<T>): Promise<{ result: T; maxGapMs: number }> {
    let last = performance.now();
    let maxGapMs = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      maxGapMs = Math.max(maxGapMs, now - last - 5);
      last = now;
    }, 5);
    try {
      return { result: await fn(), maxGapMs };
    } finally {
      clearInterval(timer);
    }
  }

  it("rejects the audit's reproduction before any revision or write, without stalling the loop", async () => {
    fake.addNote({
      noteId: 'r8',
      title: 'R8',
      type: 'code',
      mime: 'text/plain',
      parentNoteId: 'home',
      content: 'a'.repeat(2000),
    });
    const before = fake.calls.length;
    const { result, maxGapMs } = await withLoopWatch(() =>
      services.notes
        .patch({
          noteId: 'r8',
          expectedHash: fake.blobId('r8'),
          operation: 'edit',
          edits: [{ find: '(z)?a', replace: '$1'.repeat(100_000), regex: true, all: true }],
        })
        .catch((e: unknown) => e),
    );
    expect(result).toMatchObject({
      code: 'TOO_LARGE',
      details: { cost: 200_000_000, limit: MAX_REPLACEMENT_WORK },
    });
    expect(maxGapMs).toBeLessThan(300);
    expect(
      fake.calls.slice(before).some((c) => c.method === 'PUT' || /\/revision$/.test(c.path)),
    ).toBe(false);
    expect(fake.notes.get('r8')?.content).toBe('a'.repeat(2000));
  });

  it('rejects the 10 000-match variant immediately and charges work across edits of one call', async () => {
    const started = performance.now();
    await expect(
      applyEdit(
        'a'.repeat(10_000),
        { find: '(z)?a', replace: '$1'.repeat(100_000), regex: true, all: true },
        'e',
        500,
      ),
    ).rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect(performance.now() - started).toBeLessThan(1500);
    // Two edits each within the budget alone, but not together: the second is refused before expansion.
    fake.addNote({
      noteId: 'r8b',
      title: 'R8b',
      type: 'code',
      mime: 'text/plain',
      parentNoteId: 'home',
      content: 'a'.repeat(3000),
    });
    const halfPlus = '$1'.repeat(999) + '$&'; // 1000 tokens × 3000 matches = 3M per edit; keeps each 'a' so edit 2 still matches
    await expect(
      services.notes.patch({
        noteId: 'r8b',
        expectedHash: fake.blobId('r8b'),
        operation: 'edit',
        edits: [
          { find: '(z)?a', replace: halfPlus, regex: true, all: true },
          { find: '(z)?a', replace: halfPlus, regex: true, all: true },
        ],
      }),
    ).rejects.toMatchObject({
      code: 'TOO_LARGE',
      details: { cost: 3_000_000, remaining: 2_000_000 },
    });
    expect(fake.notes.get('r8b')?.content).toBe('a'.repeat(3000));
  });

  it('the budget is explicit and ordinary large edits still complete', async () => {
    const work = { remaining: MAX_REPLACEMENT_WORK };
    const out = await applyEdit(
      'a'.repeat(10_000),
      { find: '(z)?a', replace: '$1b', regex: true, all: true },
      'e',
      500,
      Number.POSITIVE_INFINITY,
      work,
    );
    expect(out).toBe('b'.repeat(10_000));
    expect(work.remaining).toBe(MAX_REPLACEMENT_WORK - 2 * 10_000); // 2 tokens × 10 000 matches
    await expect(
      applyEdit('abab', { find: 'b', replace: '$$$&', regex: true, occurrence: 2 }, 'e', 500),
    ).resolves.toBe('aba$b');
    await expect(
      applyEdit('abab', { find: 'b', replace: '$1', regex: false, all: true }, 'e', 500),
    ).resolves.toBe('a$1a$1');
  });
});
