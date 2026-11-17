import { main } from "../src/utils/migrate.js";

/** `npm run migrate -- <game dir> [--to N] [--write]` (see utils/migrations/README.md). */
process.exit(main(process.argv.slice(2)));
