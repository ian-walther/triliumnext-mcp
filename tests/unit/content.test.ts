import { describe, expect, it } from 'vitest';
import {
  detectFormat,
  htmlToPlainText,
  normalizeContentForWrite,
  plainToHtml,
  truncateContent,
} from '../../src/domain/content.js';
import { DomainError } from '../../src/domain/errors.js';

describe('detectFormat', () => {
  it('detects html, markdown and plain', () => {
    expect(detectFormat('<p>Hello</p>')).toBe('html');
    expect(detectFormat('# Title\n\n- item')).toBe('markdown');
    expect(detectFormat('**bold** text')).toBe('markdown');
    expect(detectFormat('just words here')).toBe('plain');
    expect(detectFormat('a < b and c > d')).toBe('plain');
  });
});

describe('normalizeContentForWrite', () => {
  const max = 1024 * 1024;
  it('converts markdown to html for text notes', () => {
    const out = normalizeContentForWrite({
      noteType: 'text',
      content: '# Title\n\nSome *emphasis*.',
      maxBytes: max,
    });
    expect(out.inputFormat).toBe('markdown');
    expect(out.content).toContain('<h1>Title</h1>');
    expect(out.content).toContain('<em>emphasis</em>');
  });
  it('wraps plain text in paragraphs with escaping', () => {
    const out = normalizeContentForWrite({
      noteType: 'text',
      content: 'a < b\n\nsecond',
      maxBytes: max,
    });
    expect(out.content).toBe('<p>a &lt; b</p>\n<p>second</p>');
    expect(plainToHtml('line1\nline2')).toBe('<p>line1<br>line2</p>');
  });
  it('honours an explicit format', () => {
    const out = normalizeContentForWrite({
      noteType: 'text',
      content: '# not a heading',
      format: 'plain',
      maxBytes: max,
    });
    expect(out.content).toBe('<p># not a heading</p>');
    const html = normalizeContentForWrite({
      noteType: 'text',
      content: '<b>x</b>',
      format: 'html',
      maxBytes: max,
    });
    expect(html.converted).toBe(false);
  });
  it('passes code content through untouched, including html-looking generics', () => {
    const out = normalizeContentForWrite({
      noteType: 'code',
      content: 'List<String> x = a & b;',
      format: 'markdown',
      maxBytes: max,
    });
    expect(out.content).toBe('List<String> x = a & b;');
    expect(out.warnings[0]).toMatch(/ignored/);
  });
  it('enforces size and binary limits', () => {
    expect(() =>
      normalizeContentForWrite({ noteType: 'text', content: 'x'.repeat(2000), maxBytes: 1000 }),
    ).toThrow(DomainError);
    expect(() =>
      normalizeContentForWrite({ noteType: 'image', content: 'x', maxBytes: max }),
    ).toThrow(/not supported/);
  });
});

describe('htmlToPlainText', () => {
  it('strips tags, keeps block breaks and decodes entities', () => {
    expect(
      htmlToPlainText('<h1>Title</h1><p>a &amp; b<br>c</p><ul><li>one</li><li>two</li></ul>'),
    ).toBe('Title\na & b\nc\none\ntwo');
  });
});

describe('truncateContent', () => {
  it('cuts on a utf-8 boundary', () => {
    const s = 'héllo wörld';
    const t = truncateContent(s, 3);
    expect(t.truncated).toBe(true);
    expect(t.totalBytes).toBe(Buffer.byteLength(s));
    expect(Buffer.byteLength(t.content)).toBeLessThanOrEqual(3);
    expect(t.content).toBe('h');
    expect(truncateContent('abc', 10)).toEqual({ content: 'abc', truncated: false, totalBytes: 3 });
  });
});
