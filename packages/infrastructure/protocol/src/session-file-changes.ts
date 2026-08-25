import { z } from "zod";
import { utf8Encoder } from "./utf8.js";
export function countTextLines(text: string): number {
  if (text.length === 0) return 0;
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) count += 1;
  }
  return text.endsWith("\n") ? count : count + 1;
}

export const SessionFileEditOperationSchema = z
  .object({
    type: z.literal("edit"),
    timestamp: z.string().datetime(),
    sessionId: z.string().min(1),
    op: z.enum(["create", "update", "delete", "rename"]).optional(),
    patch: z.string().min(1).optional(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((operation, context) => {
    if (!operation.patch && (operation.additions !== 0 || operation.deletions !== 0)) {
      context.addIssue({
        code: "custom",
        message: "Edits without an exact patch cannot contribute line totals",
      });
    }
  });

export const SessionFileWriteOperationSchema = z
  .object({
    type: z.literal("write"),
    timestamp: z.string().datetime(),
    sessionId: z.string().min(1),
    resolvedPath: z.string().min(1),
    byteCount: z.number().int().nonnegative(),
    snapshot: z.string().optional(),
    additions: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((operation, context) => {
    if (
      (operation.snapshot === undefined && operation.additions !== 0) ||
      (operation.snapshot !== undefined && countTextLines(operation.snapshot) !== operation.additions)
    ) {
      context.addIssue({
        code: "custom",
        message: "Write additions must match the retained snapshot",
      });
    }
    if (
      operation.snapshot !== undefined &&
      utf8Encoder.encode(operation.snapshot).byteLength !== operation.byteCount
    ) {
      context.addIssue({
        code: "custom",
        message: "Write byteCount must match the retained snapshot",
      });
    }
  });

export const SessionFileOperationSchema = z.discriminatedUnion("type", [
  SessionFileEditOperationSchema,
  SessionFileWriteOperationSchema,
]);

export const SessionChangedFileSchema = z
  .object({
    path: z.string().min(1),
    operations: z.array(SessionFileOperationSchema).min(1),
  })
  .strict()
  .superRefine((file, context) => {
    for (let index = 1; index < file.operations.length; index += 1) {
      if (Date.parse(file.operations[index - 1]!.timestamp) > Date.parse(file.operations[index]!.timestamp)) {
        context.addIssue({ code: "custom", message: "File operations must be chronological" });
        break;
      }
    }
    for (const operation of file.operations) {
      if (operation.type === "write" && operation.resolvedPath !== file.path) {
        context.addIssue({ code: "custom", message: "Write resolved path must match its file" });
      }
    }
  });

export const SessionFileChangeSourceSchema = z
  .object({
    sessionId: z.string().min(1),
    root: z.string().min(1),
    files: z.array(SessionChangedFileSchema),
  })
  .strict()
  .superRefine((source, context) => {
    const paths = new Set(source.files.map((file) => file.path));
    if (paths.size !== source.files.length) {
      context.addIssue({ code: "custom", message: "Files must be unique within a source" });
    }
    for (const file of source.files) {
      if (file.operations.some((operation) => operation.sessionId !== source.sessionId)) {
        context.addIssue({ code: "custom", message: "Operation session must match its source" });
      }
    }
  });

export const SessionFileChangesResponseSchema = z
  .object({
    sessionId: z.string().min(1),
    state: z.enum(["available", "partial", "unavailable"]),
    sources: z.array(SessionFileChangeSourceSchema),
    fileCount: z.number().int().nonnegative(),
    operationCount: z.number().int().nonnegative(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    changedLines: z.number().int().nonnegative(),
    message: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((response, context) => {
    const sourceIdentities = new Set(
      response.sources.map((source) => `${source.sessionId}\u0000${source.root}`),
    );
    const files = response.sources.flatMap((source) => source.files);
    const operations = files.flatMap((file) => file.operations);
    const edits = operations.filter(
      (operation): operation is z.infer<typeof SessionFileEditOperationSchema> => operation.type === "edit",
    );
    const additions = operations.reduce((total, operation) => total + operation.additions, 0);
    const deletions = edits.reduce((total, operation) => total + operation.deletions, 0);
    if (sourceIdentities.size !== response.sources.length) {
      context.addIssue({ code: "custom", message: "Session/worktree sources must be unique" });
    }
    if (
      response.fileCount !== files.length ||
      response.operationCount !== operations.length ||
      response.additions !== additions ||
      response.deletions !== deletions ||
      response.changedLines !== additions + deletions
    ) {
      context.addIssue({ code: "custom", message: "Session file change totals do not match sources" });
    }
    if (response.state === "unavailable" && response.sources.length > 0) {
      context.addIssue({ code: "custom", message: "Unavailable responses cannot contain sources" });
    }
  });

export type SessionChangedFile = z.infer<typeof SessionChangedFileSchema>;
export type SessionFileChangeSource = z.infer<typeof SessionFileChangeSourceSchema>;
export type SessionFileChangesResponse = z.infer<typeof SessionFileChangesResponseSchema>;
export type SessionFileOperation = z.infer<typeof SessionFileOperationSchema>;
