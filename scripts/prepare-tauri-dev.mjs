import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// iOS only needs the Vite dev server. The macOS shell also launches the bundled
// LiveTree service, so keep its compiled TypeScript and sidecar up to date.
if (process.env.TAURI_ENV_PLATFORM === "macos") {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
  const buildInfo = path.join(root, "node_modules", ".cache", "livetree-dev.tsbuildinfo");
  execFileSync(process.execPath, [tsc, "--incremental", "--tsBuildInfoFile", buildInfo], {
    cwd: root,
    stdio: "inherit",
  });
  await import("./prepare-tauri-sidecar.mjs");
}
