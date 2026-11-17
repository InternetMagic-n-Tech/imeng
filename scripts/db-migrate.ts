import "../src/utils/env-boot.js";
import { dbMain } from "../src/utils/db-cli.js";

process.exit(await dbMain(process.argv.slice(2)));
