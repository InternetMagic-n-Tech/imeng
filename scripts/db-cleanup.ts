import "../src/utils/env-boot.js";
import { cleanupMain } from "../src/utils/db-cleanup.js";

process.exit(await cleanupMain(process.argv.slice(2)));
