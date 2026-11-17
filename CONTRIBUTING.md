# Contributing

Short version:

- Engine code stays generic: game rules, stats and wording live in the game folder (`imengs/<game>`), never in `src/utils/`.
- Typecheck, lint (report-only: `npm run lint` never rewrites code), tests and coverage pass (`npm run typecheck`, `npm run lint`, `npm run test:coverage`); new behaviour has tests, failure paths included.
- Update `docs/CONFIGURATION.md` (settings), `docs/OPERATIONS.md` (running) and `docs/IMENG-MAKING.md` when a setting, step or pitfall changes.
- **Versions are frozen at 1.3** (the public release). Do not bump the root `version` or a `proxy_version`; every game's own `version` is 0.0.1 and stays there; and do not add a new version note yet: every minor version needs its md in `migrations/` once versioning restarts, but until then add changes to `migrations/1.2-to-1.3.md` under "Added since the first 1.3 cut". Start versioning again only when the next public release is cut.
- Shipped games (`game/`, the template, every `imengs/*`) keep `proxy_version` equal to the root `version` (1.3.0); a test enforces it.
- Naming: prefer `gender` over `sex` everywhere (code, config keys, docs, tests). `sexuality` stays as is.
