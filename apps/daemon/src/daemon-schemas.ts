import { EffortSchema } from "@omp-remote/protocol";
import { z } from "zod";

export const EnvironmentSchema = z.object({
  OMP_REMOTE_HOST: z.enum(["127.0.0.1", "::1", "localhost"]).default("127.0.0.1"),
  OMP_REMOTE_PORT: z.coerce.number().int().min(1).max(65_535).default(4387),
  OMP_REMOTE_ORIGIN: z.string().url().optional(),
  OMP_REMOTE_OMP_PATH: z.string().min(1).default("omp"),
});

export const RpcModelSchema = z
  .object({
    provider: z.string(),
    id: z.string(),
    name: z.string(),
    thinking: z
      .object({
        efforts: z.array(EffortSchema),
        requiresEffort: z.boolean().optional(),
      })
      .optional(),
  })
  .passthrough();

export const RpcStateResponseSchema = z.object({
  type: z.literal("response"),
  command: z.literal("get_state"),
  success: z.literal(true),
  data: z.object({
    sessionId: z.string(),
    sessionName: z.string().nullable().optional(),
    sessionFile: z.string().nullable().optional(),
    model: RpcModelSchema.nullable().optional(),
    thinkingLevel: EffortSchema.optional(),
    isStreaming: z.boolean(),
    queuedMessageCount: z.number().optional(),
    contextUsage: z.object({ percent: z.number() }).nullable().optional(),
  }),
});

export const RpcMessageFrameSchema = z.object({
  type: z.enum(["message_start", "message_update", "message_end"]),
  message: z.unknown(),
});

export const RpcMessagesResponseSchema = z.object({
  type: z.literal("response"),
  command: z.literal("get_messages"),
  success: z.literal(true),
  data: z.union([z.array(z.unknown()), z.object({ messages: z.array(z.unknown()) })]),
});

export const RpcAvailableCommandsResponseSchema = z.object({
  type: z.literal("response"),
  command: z.literal("get_available_commands"),
  success: z.literal(true),
  data: z.object({ commands: z.array(z.unknown()) }),
});

export const RpcAvailableModelsResponseSchema = z.object({
  type: z.literal("response"),
  command: z.literal("get_available_models"),
  success: z.literal(true),
  data: z.object({ models: z.array(RpcModelSchema) }),
});

export const RpcAvailableCommandsUpdateSchema = z.object({
  type: z.literal("available_commands_update"),
  commands: z.array(z.unknown()),
});
