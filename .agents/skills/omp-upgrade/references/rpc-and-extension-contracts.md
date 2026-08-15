# OMP RPC & Extension Contracts Reference

This document outlines the contracts between OMP and OMP Remote.

## 1. OMP Extension Contract (`@omp-remote/omp-extension`)

### Entry Point & Initialization

```typescript
export default function ompRemoteExtension(pi: ExtensionAPI): void {
  // Access ExtensionAPI services
  // pi.on, pi.registerCommand, pi.zod, pi.events
}
```

### Key Lifecycle Events

- `session_start`: Fired when a new session starts. Provides initial session ID, working directory, and configuration.
- `turn_start` / `turn_end`: Marks assistant turn boundaries and token counts.
- `message_append` / `message_update`: Streaming message deltas and transcript updates.
- `tool_call_start` / `tool_call_end`: Tool execution tracking (name, args, output, error).
- `tool_approval_requested`: User confirmation dialog for sensitive tool executions.
- `ask_request`: Interactive question prompts from `ask` tool or extension UI.
- `mcp_notification`: MCP server notifications and resource updates.

### Extension Context (`ExtensionContext`)

```typescript
interface ExtensionContext {
  cwd: string;
  models: {
    resolve(name: string): Promise<ModelDescriptor | null>;
    list(): Promise<ModelDescriptor[]>;
    current(): Promise<ModelDescriptor>;
  };
  ui: {
    ask(prompt: string): Promise<string>;
    askQuestion(question: ExtensionAskDialogQuestion): Promise<ExtensionAskDialogResult>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
  invokeTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  getAsyncJobSnapshot?(): Record<string, unknown>;
}
```

---

## 2. OMP RPC Process Client (`@omp-remote/omp-rpc`)

### Process Spawning

The daemon launches RPC sessions using:

```bash
omp --mode rpc --cwd <workingDirectory>
```

Optional flags:
- `--mode rpc-ui`: RPC with terminal UI mirroring
- `--trusted-extension`: Allow extension execution without interactive prompts

### Wire Framing (JSONL)

Every message over stdin/stdout is a JSON object followed by a newline `\n`:

```json
{"id": 1, "type": "request", "command": "prompt", "payload": {"text": "Hello world"}}
```

Chunked messages over the buffer size limit:

```json
{"id": 2, "type": "chunk", "chunkId": "c1", "index": 0, "count": 2, "data": "..."}
{"id": 2, "type": "chunk", "chunkId": "c1", "index": 1, "count": 2, "data": "..."}
```

### Core RPC Commands

| Command | Payload | Description |
|---|---|---|
| `prompt` | `{ text: string, attachments?: Attachment[], model?: string, thinking?: string }` | Submit turn prompt |
| `steer` | `{ text: string }` | Steer current active turn |
| `follow_up` | `{ text: string }` | Append queued follow-up instruction |
| `get_state` | `{}` | Query session state, status, model, and throughput |
| `set_model` | `{ model: string }` | Switch active model or model role |
| `set_thinking` | `{ level: string }` | Configure thinking level (`off`, `low`, `medium`, `high`, `max`, `auto`) |
| `set_fast_mode` | `{ enabled: boolean }` | Toggle fast model routing |
| `ask_response` | `{ id: string, response: string \| string[] }` | Answer pending ask question |
| `cancel` | `{}` | Cancel running generation or tool |
