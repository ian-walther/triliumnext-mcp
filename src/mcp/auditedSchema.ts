/**
 * Wraps a Zod tool schema as a Standard Schema whose `validate` reports
 * rejections. The SDK validates arguments through `~standard.validate` before
 * dispatching to the handler and advertises `~standard.jsonSchema`; both are
 * delegated unchanged, so the tool's contract and the SDK's validation stay
 * exactly as strict. Only the outcome becomes observable, which is what the
 * audit trail needs (see AUDIT R6).
 */
import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import type * as z from 'zod/v4';

export interface SchemaRejection {
  issueCount: number;
  /** Top-level argument names that failed, never their values. */
  fields: string[];
}

type StandardProps = StandardSchemaWithJSON['~standard'];

export function auditedSchema<S extends z.ZodObject>(
  schema: S,
  onReject: (rejection: SchemaRejection) => void,
): StandardSchemaWithJSON<z.input<S>, z.output<S>> {
  const inner = (schema as unknown as StandardSchemaWithJSON<z.input<S>, z.output<S>>)['~standard'];
  const report = <
    R extends { issues?: readonly { path?: readonly unknown[] | undefined }[] | undefined },
  >(
    result: R,
  ): R => {
    if (!result.issues || result.issues.length === 0) return result;
    const fields = new Set<string>();
    for (const issue of result.issues) {
      const head = issue.path?.[0];
      const key = typeof head === 'object' && head !== null && 'key' in head ? head.key : head;
      if (typeof key === 'string' || typeof key === 'number') fields.add(String(key));
    }
    onReject({ issueCount: result.issues.length, fields: [...fields].sort() });
    return result;
  };
  const validate: StandardProps['validate'] = (value, options) => {
    const result = inner.validate(value, options);
    return result instanceof Promise ? result.then(report) : report(result);
  };
  return { '~standard': { ...inner, validate } } as StandardSchemaWithJSON<z.input<S>, z.output<S>>;
}
