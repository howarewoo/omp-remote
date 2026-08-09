import type { ExtensionAskDialogResult } from "@oh-my-pi/pi-coding-agent";

export type RemoteAskOutcome =
  | { type: "response"; response: ExtensionAskDialogResult | undefined }
  | { type: "timeout" }
  | { type: "unavailable" };

export function normalizeRemoteAskResponse(value: unknown): RemoteAskOutcome | null {
  if (typeof value !== "object" || value === null) return null;
  if ("timedOut" in value && value.timedOut === true && "cancelled" in value && value.cancelled === true) {
    return { type: "timeout" };
  }
  if ("cancelled" in value && value.cancelled === true) {
    return { type: "response", response: undefined };
  }
  if ("kind" in value && value.kind === "chat") {
    return { type: "response", response: { kind: "chat" } };
  }
  if (
    !("kind" in value) ||
    value.kind !== "submit" ||
    !("results" in value) ||
    !Array.isArray(value.results)
  ) {
    return null;
  }
  for (const result of value.results) {
    if (
      typeof result !== "object" ||
      result === null ||
      !("id" in result) ||
      typeof result.id !== "string" ||
      !("question" in result) ||
      typeof result.question !== "string" ||
      !("options" in result) ||
      !isStringArray(result.options) ||
      !("multi" in result) ||
      typeof result.multi !== "boolean" ||
      !("selectedOptions" in result) ||
      !isStringArray(result.selectedOptions) ||
      ("customInput" in result &&
        result.customInput !== undefined &&
        typeof result.customInput !== "string") ||
      ("note" in result && result.note !== undefined && typeof result.note !== "string") ||
      ("timedOut" in result && result.timedOut !== undefined && typeof result.timedOut !== "boolean")
    ) {
      return null;
    }
  }
  return { type: "response", response: value as ExtensionAskDialogResult };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
