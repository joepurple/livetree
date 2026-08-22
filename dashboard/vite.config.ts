import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const dashboardDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: dashboardDir,
  base: "./",
  plugins: [solid()],
  server: {
    host: process.env.TAURI_DEV_HOST || "127.0.0.1",
    port: 1420,
    strictPort: true,
    hmr: process.env.TAURI_DEV_HOST ? {
      protocol: "ws",
      host: process.env.TAURI_DEV_HOST,
      port: 1421,
    } : undefined,
  },
  build: {
    outDir: path.resolve(dashboardDir, "../dist/dashboard"),
    emptyOutDir: false,
    target: "es2022",
  },
});
