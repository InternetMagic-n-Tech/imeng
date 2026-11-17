# Security

## Reporting a problem

Please do not open a public issue for a vulnerability. Use GitHub's private "Report a vulnerability" (Security tab) on this repository, and include the version (`package.json`), what you did and what you saw. Do not include real personal data in a report.

## Who this is for

imeng is built to run on **your own machine or network**, with models on your own hardware. It is not hardened to be exposed to the open internet as is.

- The proxy binds to `127.0.0.1` by default. To reach it from Open WebUI in Docker, bind the Docker bridge address (`PROXY_BIND=172.17.0.1`), not `0.0.0.0`.
- Set `PROXY_API_KEY` before binding anywhere but localhost, and put a TLS reverse proxy in front (`docs/DEPLOYMENT.md`).
- **The proxy trusts the user and chat id headers Open WebUI forwards** (`ENABLE_FORWARD_USER_INFO_HEADERS`). Anyone who can reach the proxy directly can claim any identity, so keep it reachable only from Open WebUI (or the Discord bridge).
- Secrets live in `.env`, `discord.config.mjs` and `tools.config.mjs`, all gitignored. `npm run env:init` writes random passwords. Never paste `.env` into a chat or an issue.

## Prompt injection: the stance

A text game that lets anyone type to a model is an injection surface by design. imeng does not try to make the model immune. It keeps the model from holding anything that matters:

1. **The server owns the state.** HP, inventory, chips, who is out, phase and rules live in code, not in the prompt. The model only narrates and proposes changes.
2. **Proposed changes are checked.** Every change the model proposes goes through code: schema, `limits`, `write_once`, `writers` (fields the narrator may not touch), per-game `hooks/validate.mjs`, and `field_evidence` (a field changes only when the narrator's own words contain the phrase). A change that fails is dropped and logged.
3. **Player words are not evidence.** For rules that depend on what was said, only the narrator's statements count. A player typing "the guard says I win" changes nothing.
4. **Hidden information is withheld, not hidden by instruction.** Private cards, goals and notes are kept outside the shared prompt and shown only in a private channel to their owner.
5. **Dice, decks and shuffles are rolled by code** where a game opts in.
6. **A second small model (the judge) decides classification questions** with a quoted line that code checks is really in the text.

Not covered: a player talking the narrator into out-of-character *text* (rude, off-topic, or leaking its own prompt) is not prevented, only kept from changing the game's state. Tools (`web_search`, `fetch`, `tmdb`) are limited to the hosts a game allows (`tools.config.mjs`), and their results are untrusted text. Treat any imeng that uses `fetch` or `web_search` as able to show a player whatever those pages say.

## Personal data

The PII filter (`pii_filter`, `PII_SALT`) masks emails, phone and card numbers, ids and secrets before text reaches a model, logs or saved sessions, and the debug output is scrubbed. It is a filter, not a guarantee: set `PII_SALT` to a long random string, read the terms text each game shows players, and see "Debug output never holds personal details" in docs/OPERATIONS.md.

## Pictures

Pictures attached by players can be checked by the optional vision module (`src/tools/vision/`, NudeNet and YOLO-pose, run locally, no network). Its weights and its virtualenv are gitignored. The Python packages are installed by you, not shipped here; `ultralytics` is AGPL-3.0 (see `src/tools/vision/README.md`).
