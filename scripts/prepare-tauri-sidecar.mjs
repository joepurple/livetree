import { cpSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const tauriDir = path.join(root, "src-tauri");
const triple = execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" }).trim();
if (!triple.endsWith("apple-darwin")) {
  throw new Error(`The bundled LiveTree sidecar is currently supported on macOS, not ${triple}.`);
}

const binariesDir = path.join(tauriDir, "binaries");
const resourcesDir = path.join(tauriDir, "resources", "livetree");
mkdirSync(binariesDir, { recursive: true });
copyFileSync(process.execPath, path.join(binariesDir, `livetree-node-${triple}`));

rmSync(resourcesDir, { recursive: true, force: true });
mkdirSync(resourcesDir, { recursive: true });
cpSync(path.join(root, "dist"), path.join(resourcesDir, "dist"), { recursive: true });
for (const dependency of ["portless", "yaml"]) {
  cpSync(
    path.join(root, "node_modules", dependency),
    path.join(resourcesDir, "node_modules", dependency),
    { recursive: true },
  );
}

console.log(`Prepared the LiveTree sidecar for ${triple}.`);
