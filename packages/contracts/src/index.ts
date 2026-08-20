import { z } from 'zod';

import { EV_PROTOCOL_VERSION } from './protocol';

export { EV_PROTOCOL_VERSION } from './protocol';
export * from './browser';
export * from './fleet';
export * from './runtime';
export * from './registry';

export const PageContextSchema = z.object({
  url: z.string().url().max(4096),
  title: z.string().trim().min(1).max(512),
  selection: z.string().max(100_000).optional(),
  capturedAt: z.string().datetime(),
});

export type PageContext = z.infer<typeof PageContextSchema>;

export const CreateTaskRequestSchema = z.object({
  protocolVersion: z.literal(EV_PROTOCOL_VERSION),
  requestId: z.string().uuid(),
  source: z.literal('browser-extension'),
  prompt: z.string().trim().min(1).max(20_000),
  page: PageContextSchema.optional(),
});

export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;

export const TaskStatusSchema = z.enum([
  'pending',
  'running',
  'waiting_for_confirmation',
  'completed',
  'failed',
  'cancelled',
]);

export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskSummarySchema = z.object({
  id: z.string().min(1),
  status: TaskStatusSchema,
  title: z.string().max(512),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type TaskSummary = z.infer<typeof TaskSummarySchema>;

export const AgentEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('task.status'),
    task: TaskSummarySchema,
  }),
  z.object({
    type: z.literal('task.output'),
    taskId: z.string().min(1),
    delta: z.string(),
  }),
  z.object({
    type: z.literal('task.error'),
    taskId: z.string().min(1),
    code: z.string().min(1),
    message: z.string(),
  }),
]);

export type AgentEvent = z.infer<typeof AgentEventSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;
