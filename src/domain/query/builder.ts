/**
 * Builds Trilium search DSL strings from structured criteria.
 *
 * Grammar notes (TriliumNext search):
 *   - fulltext tokens: `docker "exact phrase"`
 *   - labels:    `#book`, `#!book` (absent), `#year >= 2000`, `#tag *=* 'part'`
 *   - relations: `~author.title = 'Tolkien'`, `~template.noteId = '_template_board'`
 *   - properties: `note.title *=* 'x'`, `note.type = 'code'`, `note.isArchived = false`,
 *                 `note.dateCreated >= TODAY-7`, `note.labelCount > 3`,
 *                 hierarchy: `note.parents.noteId = 'abc'`, `note.ancestors.title = 'Y'`
 *   - grouping: `~(#a OR #b)` — a parenthesised group at expression position is
 *     prefixed with `~` so the parser treats it as an expression, not fulltext.
 *
 * Logic semantics: each criterion's `logic` joins it to the NEXT criterion.
 * OR binds tighter than AND, so `A OR B AND C` means `(A OR B) AND C` and
 * `A AND B OR C` means `A AND (B OR C)`. Nothing is silently dropped: a
 * criterion that cannot be rendered raises a validation error.
 */
import { DomainError } from '../errors.js';
import { NOTE_TYPES } from '../../etapi/types.js';

export const CRITERION_TYPES = ['label', 'relation', 'noteProperty'] as const;
export type CriterionType = (typeof CRITERION_TYPES)[number];

export const OPERATORS = [
  'exists',
  'not_exists',
  '=',
  '!=',
  '>',
  '>=',
  '<',
  '<=',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'regex',
] as const;
export type Operator = (typeof OPERATORS)[number];

export interface Criterion {
  type: CriterionType;
  property: string;
  op?: Operator | undefined;
  value?: string | undefined;
  logic?: 'AND' | 'OR' | undefined;
}

export interface SearchQueryInput {
  text?: string | undefined;
  criteria?: Criterion[] | undefined;
  /** Raw Trilium search DSL appended verbatim (escape hatch). */
  query?: string | undefined;
}

const OP_SYMBOL: Record<Exclude<Operator, 'exists' | 'not_exists'>, string> = {
  '=': '=',
  '!=': '!=',
  '>': '>',
  '>=': '>=',
  '<': '<',
  '<=': '<=',
  contains: '*=*',
  not_contains: '!*=*',
  starts_with: '=*',
  ends_with: '*=',
  regex: '%=',
};

const BOOLEAN_PROPERTIES = new Set(['isArchived', 'isProtected']);
const NUMERIC_PROPERTIES = new Set([
  'labelCount',
  'ownedLabelCount',
  'attributeCount',
  'ownedAttributeCount',
  'relationCount',
  'ownedRelationCount',
  'parentCount',
  'childrenCount',
  'contentSize',
  'noteSize',
  'revisionCount',
  'contentAndAttachmentsSize',
  'contentAndAttachmentsAndRevisionsSize',
]);
const DATE_PROPERTIES = new Set([
  'dateCreated',
  'dateModified',
  'utcDateCreated',
  'utcDateModified',
]);
const STRING_PROPERTIES = new Set([
  'title',
  'content',
  'text',
  'type',
  'mime',
  'noteId',
  'rawContent',
]);
const HIERARCHY_PREFIX =
  /^(parents|children|ancestors)(\.(parents|children|ancestors))*\.(noteId|title|type|mime|isArchived|labelCount|childrenCount|parentCount)$/;
const HIERARCHY_BARE = /^(parents|children|ancestors)$/;

const SMART_DATE = /^(NOW|TODAY|WEEK|MONTH|YEAR)([+-]\d+)?$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const ATTRIBUTE_NAME = /^[^\s'"()#~]+$/;

/** Quote a string literal for the Trilium search DSL. */
export function quote(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function renderComparison(
  subject: string,
  op: Operator,
  rawValue: string | undefined,
  kind: 'string' | 'number' | 'boolean' | 'date',
  where: string,
): string {
  if (op === 'exists' || op === 'not_exists') {
    throw DomainError.validation(
      `${where}: operator '${op}' is only valid for labels and relations`,
    );
  }
  if (rawValue === undefined || rawValue === '') {
    throw DomainError.validation(`${where}: operator '${op}' requires a value`);
  }
  const symbol = OP_SYMBOL[op];
  switch (kind) {
    case 'boolean': {
      const v = rawValue.trim().toLowerCase();
      if (v !== 'true' && v !== 'false')
        throw DomainError.validation(`${where}: expected 'true' or 'false', got '${rawValue}'`);
      if (op !== '=' && op !== '!=')
        throw DomainError.validation(`${where}: boolean properties support only '=' and '!='`);
      return `${subject} ${symbol} ${v}`;
    }
    case 'number': {
      const v = rawValue.trim();
      if (!/^-?\d+(\.\d+)?$/.test(v))
        throw DomainError.validation(`${where}: expected a number, got '${rawValue}'`);
      return `${subject} ${symbol} ${v}`;
    }
    case 'date': {
      const v = rawValue.trim();
      if (SMART_DATE.test(v)) return `${subject} ${symbol} ${v.toUpperCase()}`;
      if (ISO_DATE.test(v)) return `${subject} ${symbol} ${quote(v)}`;
      throw DomainError.validation(
        `${where}: expected an ISO date (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss) or a smart date (TODAY-7, MONTH-1, YEAR, NOW+1), got '${rawValue}'`,
      );
    }
    default:
      return `${subject} ${symbol} ${quote(rawValue)}`;
  }
}

function renderAttribute(criterion: Criterion, index: number): string {
  const where = `criteria[${index}]`;
  const prefix = criterion.type === 'label' ? '#' : '~';
  const name = criterion.property.trim();
  if (!ATTRIBUTE_NAME.test(name))
    throw DomainError.validation(
      `${where}: invalid ${criterion.type} name '${criterion.property}'`,
    );
  const op = criterion.op ?? 'exists';
  if (op === 'exists') return `${prefix}${name}`;
  if (op === 'not_exists') return `${prefix}!${name}`;
  if (criterion.type === 'relation' && !name.includes('.')) {
    // A relation points at a note; comparing it needs a property of the target.
    const value = (criterion.value ?? '').trim();
    const looksLikeId =
      /^_?[A-Za-z0-9_]{6,64}$/.test(value) &&
      (value.startsWith('_') || /\d/.test(value) || /[A-Z]/.test(value));
    return renderComparison(
      `~${name}.${looksLikeId ? 'noteId' : 'title'}`,
      op,
      value,
      'string',
      where,
    );
  }
  return renderComparison(`${prefix}${name}`, op, criterion.value, 'string', where);
}

function renderNoteProperty(criterion: Criterion, index: number): string {
  const where = `criteria[${index}]`;
  const property = criterion.property.trim();
  const op = criterion.op ?? '=';
  if (HIERARCHY_BARE.test(property)) {
    throw DomainError.validation(
      `${where}: hierarchy property '${property}' needs a sub-property, e.g. '${property}.noteId' or '${property}.title'`,
    );
  }
  if (HIERARCHY_PREFIX.test(property)) {
    const leaf = property.slice(property.lastIndexOf('.') + 1);
    const kind = BOOLEAN_PROPERTIES.has(leaf)
      ? 'boolean'
      : NUMERIC_PROPERTIES.has(leaf)
        ? 'number'
        : 'string';
    return renderComparison(`note.${property}`, op, criterion.value, kind, where);
  }
  if (BOOLEAN_PROPERTIES.has(property))
    return renderComparison(`note.${property}`, op, criterion.value, 'boolean', where);
  if (NUMERIC_PROPERTIES.has(property))
    return renderComparison(`note.${property}`, op, criterion.value, 'number', where);
  if (DATE_PROPERTIES.has(property))
    return renderComparison(`note.${property}`, op, criterion.value, 'date', where);
  if (STRING_PROPERTIES.has(property)) {
    if (
      property === 'type' &&
      criterion.value !== undefined &&
      !(NOTE_TYPES as readonly string[]).includes(criterion.value)
    ) {
      throw DomainError.validation(
        `${where}: unknown note type '${criterion.value}' (expected one of ${NOTE_TYPES.join(', ')})`,
      );
    }
    return renderComparison(`note.${property}`, op, criterion.value, 'string', where);
  }
  throw DomainError.validation(
    `${where}: unknown note property '${property}'. Known: ${[...STRING_PROPERTIES, ...BOOLEAN_PROPERTIES, ...DATE_PROPERTIES, ...NUMERIC_PROPERTIES].join(', ')}, or hierarchy paths like parents.noteId, ancestors.title, children.title`,
  );
}

export function renderCriterion(criterion: Criterion, index: number): string {
  if (!(CRITERION_TYPES as readonly string[]).includes(criterion.type)) {
    throw DomainError.validation(`criteria[${index}]: unknown type '${String(criterion.type)}'`);
  }
  if (criterion.op !== undefined && !(OPERATORS as readonly string[]).includes(criterion.op)) {
    throw DomainError.validation(`criteria[${index}]: unknown operator '${String(criterion.op)}'`);
  }
  return criterion.type === 'noteProperty'
    ? renderNoteProperty(criterion, index)
    : renderAttribute(criterion, index);
}

/** Render criteria to a DSL fragment honouring the OR-binds-tighter rule. */
export function renderCriteria(criteria: Criterion[]): string {
  const groups: string[][] = [[]];
  criteria.forEach((criterion, index) => {
    const rendered = renderCriterion(criterion, index);
    groups[groups.length - 1]!.push(rendered);
    const logic = criterion.logic ?? 'AND';
    if (index < criteria.length - 1 && logic === 'AND') groups.push([]);
  });
  return groups
    .filter((g) => g.length > 0)
    .map((g) => (g.length === 1 ? g[0]! : `~(${g.join(' OR ')})`))
    .join(' ');
}

export function buildSearchQuery(input: SearchQueryInput): string {
  const parts: string[] = [];
  const text = input.text?.trim();
  if (text) parts.push(text);
  if (input.criteria && input.criteria.length > 0) parts.push(renderCriteria(input.criteria));
  const raw = input.query?.trim();
  if (raw) parts.push(raw);
  const query = parts.join(' ').trim();
  if (!query) throw DomainError.validation('Provide at least one of text, criteria, or query');
  return query;
}
