import "../src/utils/env-boot.js";
import { hubSettings, startHub } from "../src/hub/main.js";

// `npm run hub`: one port, every game under imengs/ as a model; each game runs in its own hidden process. See docs/OPERATIONS.md, "Running several games".
if (!(await startHub(hubSettings()))) process.exit(1);
