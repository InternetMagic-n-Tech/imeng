import { loadEnv } from "./load-env.js";

// Side-effect import: put it first in an entry file so config.ts sees the .env values.
loadEnv();
