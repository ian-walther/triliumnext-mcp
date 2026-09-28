/** Regressions for audit findings R15 (schema backtracking) and R16 (base64 padding). */
import { describe, expect, it } from 'vitest';
import { decodeBinaryInput } from '../../src/domain/binary.js';
import { BASE64_INPUT_PATTERN, base64Schema } from '../../src/mcp/schemas.js';

function timed(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

describe('R15 base64 input validation is linear', () => {
  it('rejects a long whitespace run followed by junk in linear time, raw and data URI', () => {
    const forms = (n: number) => [
      ' '.repeat(n) + '!',
      'data:image/png;base64,' + ' '.repeat(n) + '!',
      'AAAA' + '\n'.repeat(n) + '=' + ' '.repeat(n) + '!',
    ];
    for (const input of forms(60_000)) {
      const ms = timed(() => expect(BASE64_INPUT_PATTERN.test(input)).toBe(false));
      expect(ms).toBeLessThan(100);
      expect(base64Schema.safeParse(input).success).toBe(false);
    }
    // Scaling check: 4x the input must not cost anywhere near 16x the time.
    const small = Math.max(
      1,
      timed(() => BASE64_INPUT_PATTERN.test(forms(50_000)[0]!)),
    );
    const large = timed(() => BASE64_INPUT_PATTERN.test(forms(200_000)[0]!));
    expect(large / small).toBeLessThan(8);
  });

  it('still accepts the valid shapes', () => {
    for (const ok of [
      'YWJj',
      'YWJj\n',
      ' YW Jj ',
      'YWI=',
      'YQ==',
      'YQ== ',
      'YQ=\n=\n',
      'data:image/png;base64,YWJj',
      'data:;base64,YWJj',
      '',
    ]) {
      expect(BASE64_INPUT_PATTERN.test(ok)).toBe(true);
    }
    for (const bad of ['YWJj===', '=YWJj', 'YW=Jj', 'data:image/png;base64,YWJj,x', 'YW$j']) {
      expect(BASE64_INPUT_PATTERN.test(bad)).toBe(false);
    }
  });
});

describe('R16 padding must agree with the data length', () => {
  it('rejects padding-only and malformed padded inputs', () => {
    for (const bad of ['=', '==', 'AAAA==', 'AAAA=', 'AAA==', 'AA=', 'A', 'AAAAA', 'YWJj=']) {
      expect(() => decodeBinaryInput(bad, 100, 'x')).toThrow(/valid base64|empty/);
      expect(() => decodeBinaryInput('data:application/pdf;base64,' + bad, 100, 'x')).toThrow(
        /valid base64|empty/,
      );
    }
  });

  it('predicts the decoded length exactly across lengths mod 3 and 4, padded and unpadded', () => {
    for (let len = 1; len <= 40; len++) {
      const bytes = Buffer.alloc(len, len);
      const padded = bytes.toString('base64');
      const unpadded = padded.replace(/=+$/, '');
      for (const enc of [padded, unpadded, padded.replace(/(.{5})/g, '$1\n')]) {
        const out = decodeBinaryInput(enc, 1000, 'x');
        expect(out.bytes.equals(bytes)).toBe(true);
      }
    }
  });

  it('enforces the decoded-size cap just below, at, and above the limit', () => {
    const three = Buffer.from('abc').toString('base64');
    expect(decodeBinaryInput(three, 3, 'x').bytes.length).toBe(3);
    expect(() => decodeBinaryInput(three, 2, 'x')).toThrow(/limit is 2 bytes/);
    const two = Buffer.from('ab').toString('base64');
    expect(decodeBinaryInput(two, 2, 'x').bytes.length).toBe(2);
    expect(() => decodeBinaryInput(two, 1, 'x')).toThrow(/limit is 1 bytes/);
    expect(() => decodeBinaryInput('AAAA==', 2, 'x')).toThrow(/valid base64/);
  });
});
