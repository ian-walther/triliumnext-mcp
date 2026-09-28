import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/server';
import type * as z from 'zod/v4';
import type { Scope } from '../../config.js';
import type { Principal } from '../policy.js';

export interface ToolContext {
  principal: Principal;
  era: 'legacy' | 'modern';
}

export interface ToolDefinition<Input extends z.ZodObject, Output extends z.ZodObject> {
  name: string;
  scope: Scope;
  config: {
    title: string;
    description: string;
    inputSchema: Input;
    outputSchema: Output;
    annotations: ToolAnnotations;
  };
  /** Note ids touched by a call, for the audit record. */
  noteIds: (args: z.infer<Input>) => string[];
  handler: (args: z.infer<Input>, ctx: ToolContext) => Promise<CallToolResult>;
}

/** Type-erased view used by the server factory. */
export interface AnyToolDefinition {
  name: string;
  scope: Scope;
  config: ToolDefinition<z.ZodObject, z.ZodObject>['config'];
  noteIds: (args: unknown) => string[];
  handler: (args: unknown, ctx: ToolContext) => Promise<CallToolResult>;
}

export function defineTool<Input extends z.ZodObject, Output extends z.ZodObject>(
  def: ToolDefinition<Input, Output>,
): AnyToolDefinition {
  return def as unknown as AnyToolDefinition;
}
