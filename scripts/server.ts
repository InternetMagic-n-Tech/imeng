import "../src/utils/env-boot.js";
import { bootstrap } from "../src/utils/bootstrap.js";

// Start the proxy (optionally after the doctor's preflight checks); exit 1 if it could not start.
if (!(await bootstrap())) process.exit(1);
