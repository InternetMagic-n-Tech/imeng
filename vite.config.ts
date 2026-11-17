import { defineConfig } from "vite";

// Builds the Node server (SSR build, ESM) to dist/server.js, plus dist/judge-host.js (host-side judge launcher). Dependencies (express, redis, yargs...)
// stay external and are loaded from node_modules at runtime.
export default defineConfig({
  build: {
    ssr: true,
    outDir: "dist",
    target: "node22",
    sourcemap: true,
    emptyOutDir: true,
    // src/utils/spawn-helper.cjs is plain CommonJS that we bundle as-is.
    commonjsOptions: { include: [/spawn-helper\.cjs$/, /node_modules/] },
    rollupOptions: {
      input: { server: "scripts/server.ts", "judge-host": "scripts/judge-host.ts", "discord-bridge": "scripts/discord-bridge.ts", hub: "scripts/hub.ts", "db-migrate": "scripts/db-migrate.ts", "db-cleanup": "scripts/db-cleanup.ts" },
      output: { format: "esm", entryFileNames: "[name].js" },
    },
  },
});
