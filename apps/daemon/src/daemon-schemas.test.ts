import { describe, expect, it } from "vitest";
import { EnvironmentSchema } from "./daemon-schemas.js";

describe("EnvironmentSchema host boundary", () => {
  it.each(["127.0.0.1", "::1", "localhost"])("accepts loopback host %s", (host) => {
    expect(EnvironmentSchema.parse({ OMP_REMOTE_HOST: host }).OMP_REMOTE_HOST).toBe(host);
  });

  it.each(["0.0.0.0", "192.168.1.20", "host.tailnet.ts.net"])("rejects non-loopback host %s", (host) => {
    expect(() => EnvironmentSchema.parse({ OMP_REMOTE_HOST: host })).toThrow();
  });
});
