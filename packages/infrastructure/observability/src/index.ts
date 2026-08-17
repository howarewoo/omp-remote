export interface Logger {
  info(message: string, fields?: Record<string, string | number | boolean | null>): void;
  warn(message: string, fields?: Record<string, string | number | boolean | null>): void;
  error(message: string, error: unknown, fields?: Record<string, string | number | boolean | null>): void;
}

export type ErrorLogEntry = {
  timestamp: string;
  level: "error";
  service: string;
  message: string;
  error: { name?: string; message: string; stack?: string };
  rawError?: unknown;
  fields: Record<string, string | number | boolean | null>;
};

export type ErrorObserver = (entry: ErrorLogEntry) => void | Promise<void>;

export interface LoggerOptions {
  onError?: ErrorObserver;
}

export function createLogger(service: string, optionsOrObserver?: LoggerOptions | ErrorObserver): Logger {
  const observer: ErrorObserver | undefined =
    typeof optionsOrObserver === "function" ? optionsOrObserver : optionsOrObserver?.onError;

  return {
    info(message, fields = {}) {
      process.stdout.write(
        `${JSON.stringify({ ...fields, timestamp: new Date().toISOString(), level: "info", service, message })}\n`,
      );
    },
    warn(message, fields = {}) {
      process.stderr.write(
        `${JSON.stringify({ ...fields, timestamp: new Date().toISOString(), level: "warn", service, message })}\n`,
      );
    },
    error(message, error, fields = {}) {
      const timestamp = new Date().toISOString();
      const normalized =
        error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) };
      process.stderr.write(
        `${JSON.stringify({ ...fields, timestamp, level: "error", service, message, error: normalized })}\n`,
      );

      if (observer) {
        try {
          const stack = error instanceof Error ? error.stack : undefined;
          const entry: ErrorLogEntry = {
            timestamp,
            level: "error",
            service,
            message,
            error: { ...normalized, ...(stack ? { stack } : {}) },
            rawError: error,
            fields,
          };
          const result = observer(entry);
          if (result && typeof (result as Promise<unknown>).catch === "function") {
            (result as Promise<unknown>).catch(() => undefined);
          }
        } catch {
          // Prevent observer failures from suppressing logging or bubbling to caller
        }
      }
    },
  };
}
