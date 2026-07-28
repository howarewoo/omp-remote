import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

type DaemonEnvironment = {
  OMP_REMOTE_HOST?: string;
  OMP_REMOTE_PORT?: string;
};

export function resolveDaemonTargets(environment: DaemonEnvironment) {
  const host = environment.OMP_REMOTE_HOST ?? "127.0.0.1";
  const port = Number(environment.OMP_REMOTE_PORT ?? "4387");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("OMP_REMOTE_PORT must be an integer between 1 and 65535");
  }
  const urlHost = host.includes(":") ? `[${host}]` : host;

  return {
    http: `http://${urlHost}:${port}`,
    ws: `ws://${urlHost}:${port}`,
  };
}

const daemonTargets = resolveDaemonTargets(process.env);

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "OMP Remote",
        short_name: "OMP Remote",
        description: "Private multi-session control for OMP",
        theme_color: "#173630",
        background_color: "#dfe5d8",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        navigateFallback: "/index.html",
        globPatterns: ["**/*.{js,css,html,png,svg,woff2}"],
      },
    }),
  ],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/healthz": daemonTargets.http,
      "/ws": { target: daemonTargets.ws, ws: true },
    },
  },
});
