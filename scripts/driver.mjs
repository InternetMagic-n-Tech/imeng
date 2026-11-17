#!/usr/bin/env node
// Launcher: runs driver.ts through vite-node (no build step needed). `npm run driver -- <command> ...`
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const r = spawnSync(process.execPath, ["--no-warnings", ...(fs.existsSync(".env") ? ["--env-file=.env"] : []), path.join(root, "node_modules/vite-node/dist/cli.mjs"), path.join(root, "scripts/driver.ts"), ...process.argv.slice(2)], { stdio: "inherit", cwd: process.cwd() });
process.exit(r.status ?? 1);
