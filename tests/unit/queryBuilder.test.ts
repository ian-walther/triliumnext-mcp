import { describe, expect, it } from 'vitest';
import { DomainError } from '../../src/domain/errors.js';
import {
  buildSearchQuery,
  quote,
  renderCriteria,
  type Criterion,
} from '../../src/domain/query/builder.js';

const c = (partial: Partial<Criterion> & Pick<Criterion, 'type' | 'property'>): Criterion =>
  partial;

describe('quote', () => {
  it('prefers single quotes, falls back to double, escapes when both present', () => {
    expect(quote('plain')).toBe("'plain'");
    expect(quote("it's")).toBe('"it\'s"');
    expect(quote('a\'b"c')).toBe("'a\\'b\"c'");
  });
});

describe('renderCriteria', () => {
  it('renders labels with default exists and explicit operators', () => {
    expect(renderCriteria([c({ type: 'label', property: 'book' })])).toBe('#book');
    expect(renderCriteria([c({ type: 'label', property: 'book', op: 'not_exists' })])).toBe(
      '#!book',
    );
    expect(renderCriteria([c({ type: 'label', property: 'year', op: '>=', value: '2000' })])).toBe(
      "#year >= '2000'",
    );
    expect(
      renderCriteria([c({ type: 'label', property: 'tag', op: 'contains', value: 'par' })]),
    ).toBe("#tag *=* 'par'");
    expect(
      renderCriteria([c({ type: 'label', property: 'tag', op: 'regex', value: '^a.*' })]),
    ).toBe("#tag %= '^a.*'");
  });

  it('renders relations against the target title, or noteId when the value looks like an id', () => {
    expect(
      renderCriteria([c({ type: 'relation', property: 'template', op: '=', value: 'Board' })]),
    ).toBe("~template.title = 'Board'");
    expect(
      renderCriteria([
        c({ type: 'relation', property: 'template', op: '=', value: '_template_board' }),
      ]),
    ).toBe("~template.noteId = '_template_board'");
    expect(
      renderCriteria([
        c({ type: 'relation', property: 'author.title', op: 'contains', value: 'Tolkien' }),
      ]),
    ).toBe("~author.title *=* 'Tolkien'");
    expect(renderCriteria([c({ type: 'relation', property: 'author' })])).toBe('~author');
  });

  it('renders note properties with type-aware value formatting', () => {
    expect(
      renderCriteria([
        c({ type: 'noteProperty', property: 'title', op: 'contains', value: 'proj' }),
      ]),
    ).toBe("note.title *=* 'proj'");
    expect(
      renderCriteria([c({ type: 'noteProperty', property: 'isArchived', value: 'true' })]),
    ).toBe('note.isArchived = true');
    expect(
      renderCriteria([c({ type: 'noteProperty', property: 'labelCount', op: '>', value: '3' })]),
    ).toBe('note.labelCount > 3');
    expect(
      renderCriteria([
        c({ type: 'noteProperty', property: 'dateCreated', op: '>=', value: 'today-7' }),
      ]),
    ).toBe('note.dateCreated >= TODAY-7');
    expect(
      renderCriteria([
        c({ type: 'noteProperty', property: 'dateModified', op: '<', value: '2024-01-01' }),
      ]),
    ).toBe("note.dateModified < '2024-01-01'");
    expect(
      renderCriteria([c({ type: 'noteProperty', property: 'parents.noteId', value: 'abc123' })]),
    ).toBe("note.parents.noteId = 'abc123'");
    expect(
      renderCriteria([c({ type: 'noteProperty', property: 'parents.parents.title', value: 'X' })]),
    ).toBe("note.parents.parents.title = 'X'");
    expect(renderCriteria([c({ type: 'noteProperty', property: 'type', value: 'code' })])).toBe(
      "note.type = 'code'",
    );
  });

  it('groups OR runs tighter than AND', () => {
    const a = c({ type: 'label', property: 'a', logic: 'OR' });
    const b = c({ type: 'label', property: 'b', logic: 'AND' });
    const d = c({ type: 'label', property: 'd' });
    expect(renderCriteria([a, b, d])).toBe('~(#a OR #b) #d');
    expect(
      renderCriteria([
        c({ type: 'label', property: 'a', logic: 'AND' }),
        c({ type: 'label', property: 'b', logic: 'OR' }),
        d,
      ]),
    ).toBe('#a ~(#b OR #d)');
    expect(renderCriteria([a, c({ type: 'label', property: 'b', logic: 'OR' }), d])).toBe(
      '~(#a OR #b OR #d)',
    );
    expect(renderCriteria([c({ type: 'label', property: 'a', logic: 'OR' })])).toBe('#a');
  });

  it('rejects instead of silently dropping bad criteria', () => {
    expect(() =>
      renderCriteria([c({ type: 'noteProperty', property: 'title', op: 'exists' })]),
    ).toThrow(DomainError);
    expect(() =>
      renderCriteria([c({ type: 'noteProperty', property: 'nope', value: 'x' })]),
    ).toThrow(/unknown note property/);
    expect(() =>
      renderCriteria([c({ type: 'noteProperty', property: 'isArchived', value: 'maybe' })]),
    ).toThrow(/true.*false/);
    expect(() =>
      renderCriteria([
        c({ type: 'noteProperty', property: 'dateCreated', op: '>=', value: 'yesterday' }),
      ]),
    ).toThrow(/smart date/);
    expect(() =>
      renderCriteria([c({ type: 'noteProperty', property: 'type', value: 'canvasx' })]),
    ).toThrow(/unknown note type/);
    expect(() => renderCriteria([c({ type: 'label', property: 'x', op: '=' })])).toThrow(
      /requires a value/,
    );
    expect(() =>
      renderCriteria([c({ type: 'noteProperty', property: 'parents', value: 'x' })]),
    ).toThrow(/sub-property/);
  });
});

describe('buildSearchQuery', () => {
  it('combines text, criteria and raw query', () => {
    expect(
      buildSearchQuery({
        text: 'docker',
        criteria: [c({ type: 'label', property: 'infra' })],
        query: 'note.type = "text"',
      }),
    ).toBe('docker #infra note.type = "text"');
  });
  it('requires at least one input', () => {
    expect(() => buildSearchQuery({})).toThrow(/at least one/);
    expect(() => buildSearchQuery({ text: '   ' })).toThrow(/at least one/);
  });
});
