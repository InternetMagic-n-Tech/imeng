import fs from "node:fs";
import { jsonSchema } from "../src/utils/config-schema.js";

/** `npm run schema`: write imeng.schema.json (the JSON Schema of config.json). */
fs.writeFileSync("imeng.schema.json", JSON.stringify(jsonSchema(), null, 2) + "\n");
console.log("wrote imeng.schema.json");
