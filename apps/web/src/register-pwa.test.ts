import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pwaClient = vi.hoisted(() => ({
  registerSW: vi.fn(),
}));

vi.mock("virtual:pwa-register", () => pwaClient);

import { registerPwa } from "./register-pwa.js";

type RegistrationOptions = {
  immediate?: boolean;
  onRegisteredSW?: (serviceWorkerUrl: string, registration?: ServiceWorkerRegistration) => void;
  onRegisterError?: (error: unknown) => void;
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PWA registration", () => {
  it("registers immediately and explicitly checks an existing registration exactly once", () => {
    const update = vi.fn().mockResolvedValue(undefined);

    registerPwa();

    expect(pwaClient.registerSW).toHaveBeenCalledWith(expect.objectContaining({ immediate: true }));

    const options = pwaClient.registerSW.mock.calls[0]?.[0] as RegistrationOptions;
    options.onRegisteredSW?.("/sw.js", { update } as unknown as ServiceWorkerRegistration);

    expect(update).toHaveBeenCalledOnce();
  });

  it("reports registration errors", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const registrationError = new Error("registration failed");

    registerPwa();
    const options = pwaClient.registerSW.mock.calls[0]?.[0] as RegistrationOptions;
    options.onRegisterError?.(registrationError);

    expect(consoleError.mock.calls.flat()).toContain(registrationError);
  });

  it("reports rejected update checks without leaving an unhandled rejection", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const updateError = new Error("update failed");
    const update = vi.fn().mockRejectedValue(updateError);

    registerPwa();
    const options = pwaClient.registerSW.mock.calls[0]?.[0] as RegistrationOptions;
    options.onRegisteredSW?.("/sw.js", { update } as unknown as ServiceWorkerRegistration);

    await vi.waitFor(() => {
      expect(consoleError.mock.calls.flat()).toContain(updateError);
    });
  });
});
