import type { Migration } from "./index.js";

/** Copy to `v<N>-to-v<N+1>.ts`, rename the export, and add it to MIGRATIONS in index.ts. Example: key `old_name` becomes `new_name`. */
export const vNToVM: Migration = {
  from: 1,
  to: 2,
  title: "old_name renamed to new_name",
  up: ({ old_name, ...rest }) => (old_name === undefined ? rest : { ...rest, new_name: old_name }),
  down: ({ new_name, ...rest }) => (new_name === undefined ? rest : { ...rest, old_name: new_name }),
  notes: ["SYSTEM_PROMPT.md: if it mentions old_name, say new_name.", "HOW_TO_TEST.md: update any case that sets old_name."],
  rollbackNotes: ["Nothing is lost by this rollback."],
};
