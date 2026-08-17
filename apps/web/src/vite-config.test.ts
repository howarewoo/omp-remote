import { afterEach, describe, expect, it, vi } from "vitest";
import { pwaManifest, resolveDaemonTargets } from "../vite.config.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("PWA manifest configuration", () => {
  it("locks installed apps to portrait orientation", () => {
    expect(pwaManifest.orientation).toBe("portrait");
  });
});

describe("Vite daemon proxy configuration", () => {
  it("uses normalized custom IPv6 daemon targets for HTTP and WebSocket proxies", async () => {
    vi.resetModules();
    vi.stubEnv("OMP_REMOTE_HOST", "::1");
    vi.stubEnv("OMP_REMOTE_PORT", "4388.0");

    // Import after stubbing because the config reads daemon environment values during module loading.
    const { default: config } = await import("../vite.config.js");

    expect(config.server?.proxy?.["/healthz"]).toBe("http://[::1]:4388");
    expect(config.server?.proxy?.["/ws"]).toEqual({ target: "ws://[::1]:4388", ws: true });
  });

  it("normalizes daemon ports using the daemon's numeric semantics", () => {
    expect(resolveDaemonTargets({ OMP_REMOTE_HOST: "localhost", OMP_REMOTE_PORT: "0x1124" })).toEqual({
      http: "http://localhost:4388",
      ws: "ws://localhost:4388",
    });
  });

  it.each(["0", "65536", "4388.5", "not-a-port"])("rejects invalid daemon port %s", (port) => {
    expect(() => resolveDaemonTargets({ OMP_REMOTE_PORT: port })).toThrow("OMP_REMOTE_PORT");
  });
});
