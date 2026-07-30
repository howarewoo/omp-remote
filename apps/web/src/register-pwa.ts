import { registerSW } from "virtual:pwa-register";

function reportPwaError(error: unknown) {
  console.error("PWA service worker error", error);
}

export function registerPwa() {
  registerSW({
    immediate: true,
    onRegisteredSW(_serviceWorkerUrl, registration) {
      if (registration) void registration.update().catch(reportPwaError);
    },
    onRegisterError: reportPwaError,
  });
}
