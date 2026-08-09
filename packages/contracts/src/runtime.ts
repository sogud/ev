import { z } from 'zod';

export const RuntimeIdSchema = z.enum(['pi', 'codex', 'claude-code', 'qoder']);
export type RuntimeId = z.infer<typeof RuntimeIdSchema>;

export const RuntimeSessionRefSchema = z.object({
  runtimeId: RuntimeIdSchema,
  nativeId: z.string().trim().min(1).max(512),
  sessionFile: z.string().max(4096).optional(),
});
export type RuntimeSessionRef = z.infer<typeof RuntimeSessionRefSchema>;

export const RuntimeCapabilitiesSchema = z.object({
  models: z.boolean(),
  thinkingLevels: z.boolean(),
  tools: z.boolean(),
  resumeSession: z.boolean(),
  structuredEvents: z.boolean(),
  permissionModes: z.boolean(),
});

export const RuntimeDescriptorSchema = z.object({
  id: RuntimeIdSchema,
  name: z.string().trim().min(1).max(100),
  availability: z.enum(['available', 'missing', 'unsupported']),
  version: z.string().max(100).optional(),
  message: z.string().max(500).optional(),
  glyph: z.string().max(4).optional(),
  /** 非 pi runtime 的模型候选表（pi 走 provider 目录）；空/缺省 = UI 显示「暂不支持」。 */
  modelCatalog: z
    .array(z.object({ id: z.string().max(200), name: z.string().max(200) }))
    .optional(),
  /** 原生认证只读探测（native-auth-display-v1）：EV 零凭据持有，只看不写。 */
  auth: z
    .object({
      status: z.enum(['logged_in', 'logged_out', 'unknown']),
      account: z.string().max(200).optional(),
      configPaths: z.array(z.string().max(500)).optional(),
      loginCommand: z.string().max(200).optional(),
      hint: z.string().max(500).optional(),
    })
    .optional(),
  capabilities: RuntimeCapabilitiesSchema,
});
export type RuntimeDescriptor = z.infer<typeof RuntimeDescriptorSchema>;

export const RuntimeEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('status'),
    status: z.enum(['idle', 'running', 'error']),
    error: z.string().max(10_000).optional(),
  }),
  z.object({
    type: z.literal('message'),
    id: z.string().trim().min(1).max(512),
    role: z.enum(['user', 'assistant', 'thinking', 'tool', 'error', 'system']),
    content: z.string().max(16 * 1024 * 1024),
    timestamp: z.number().int().nonnegative(),
    toolName: z.string().max(200).optional(),
    toolStatus: z.enum(['running', 'done', 'error']).optional(),
  }),
  z.object({
    type: z.literal('session'),
    session: RuntimeSessionRefSchema,
    model: z
      .object({
        provider: z.string().trim().min(1).max(200),
        id: z.string().trim().min(1).max(500),
        name: z.string().trim().min(1).max(500),
      })
      .optional(),
    thinkingLevel: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
  }),
]);
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;
