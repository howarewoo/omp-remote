export interface Logger {
  info(message: string, fields?: Record<string, string | number | boolean | null>): void;
  error(message: string, error: unknown, fields?: Record<string, string | number | boolean | null>): void;
}

export function createLogger(service: string): Logger {
  return {
    info(message, fields = {}) {
      process.stdout.write(
        `${JSON.stringify({ timestamp: new Date().toISOString(), level: "info", service, message, ...fields })}\n`,
      );
    },
    error(message, error, fields = {}) {
      const normalized =
        error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) };
      process.stderr.write(
        `${JSON.stringify({ timestamp: new Date().toISOString(), level: "error", service, message, error: normalized, ...fields })}\n`,
      );
    },
  };
}
