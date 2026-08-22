import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const dashboardDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: dashboardDir,
  base: "./",
  plugins: [solid()],
  build: {
    outDir: path.resolve(dashboardDir, "../dist/dashboard"),
    emptyOutDir: false,
    target: "es2022",
  },
});
