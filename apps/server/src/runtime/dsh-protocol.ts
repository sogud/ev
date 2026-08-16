import { z } from 'zod';
import type { RpcResponseMatch } from './jsonl-rpc-transport';

const JsonRpcIdSchema = z.union([z.string(), z.number()]);
const JsonRpcErrorSchema = z.object({
  code: z.number().int(),
  message: z.string().max(10_000),
  data: z.unknown().optional(),
});
const JsonRpcResponseSchema = z.object({
  jsonrpc: z.literal('2.0').optional(),
  id: JsonRpcIdSchema,
  result: z.unknown().optional(),
  error: JsonRpcErrorSchema.optional(),
});

const DshSessionEventSchema = z.object({
  type: z.string().trim().min(1).max(200),
  seq: z.number().int().nonnegative(),
  time: z.number().int().nonnegative(),
  data: z.unknown(),
  ignorable: z.literal(true).optional(),
});

const DshNotificationSchema = z.discriminatedUnion('method', [
  z.object({
    jsonrpc: z.literal('2.0').optional(),
    method: z.literal('session.event'),
    params: z.object({
      sessionId: z.string().trim().min(1).max(512),
      event: DshSessionEventSchema,
    }),
  }),
  z.object({
    jsonrpc: z.literal('2.0').optional(),
    method: z.literal('session.status'),
    params: z.object({
      sessionId: z.string().trim().min(1).max(512),
      status: z.enum(['idle', 'running']),
    }),
  }),
  z.object({
    jsonrpc: z.literal('2.0').optional(),
    method: z.literal('subagent.started'),
    params: z.object({
      parentSessionId: z.string().trim().min(1).max(512),
      childSessionId: z.string().trim().min(1).max(512),
    }),
  }),
  z.object({
    jsonrpc: z.literal('2.0').optional(),
    method: z.literal('subagent.finished'),
    params: z.object({
      provider: z.string().trim().min(1).max(200),
      agentId: z.string().trim().min(1).max(512),
      parentSessionId: z.string().trim().min(1).max(512),
      childSessionId: z.string().trim().min(1).max(512),
      status: z.enum(['ok', 'error']),
      stopReason: z.unknown(),
      lastAssistantMessage: z.array(z.unknown()).optional(),
    }),
  }),
]);

const InitializeResultSchema = z.object({
  serverInfo: z.object({
    name: z.literal('deepseek-harness-sdk-runtime'),
    version: z.string().trim().min(1).max(100),
  }),
});

const PromptResultSchema = z.object({
  messageId: z.string().trim().min(1).max(512),
});

export type DshNotification = z.infer<typeof DshNotificationSchema>;
export type DshSessionEvent = z.infer<typeof DshSessionEventSchema>;

export function matchDshResponse(record: unknown): RpcResponseMatch | null {
  const parsed = JsonRpcResponseSchema.safeParse(record);
  if (!parsed.success) return null;
  const id = String(parsed.data.id);
  if (parsed.data.error) {
    const error = new Error(parsed.data.error.message);
    error.name = `DshJsonRpcError(${parsed.data.error.code})`;
    return { id, ok: false, error };
  }
  return { id, ok: true, value: parsed.data.result };
}

export function parseDshNotification(record: unknown): DshNotification {
  return DshNotificationSchema.parse(record);
}

export function parseDshInitializeResult(value: unknown) {
  return InitializeResultSchema.parse(value);
}

export function parseDshPromptResult(value: unknown) {
  return PromptResultSchema.parse(value);
}
