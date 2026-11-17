# Models

**The default is an environment variable; the imeng controls what it can.**

| What | Where it is set | Notes |
|---|---|---|
| Narrator and extractor | `OLLAMA_MODEL` (default `gemma4:26b`) | One default for every imeng on this machine. |
| Judge | `judge_model` in the imeng's `config.json`, or `JUDGE_MODEL` | Small, CPU-friendly classifier; falls back to the narrator model. The imeng picks its own judge. |
| Where the judge's models live | `judge_instance.models_dir` in `config.json`, or `OLLAMA_MODELS` | Machine-specific: set it for your install. |
| What the imeng was tested with | `models` in the imeng's `package.json` (name and digest per role) | A record, not a setting: update it with your test results (`docs/IMENG-MAKING.md`). |

An imeng cannot force the narrator model today. Its prompt and its server-side rules (`limits`, `writers`, validators, judges, code-rolled dice) are what make a weaker model safe to run: the model proposes, code decides. Pick the narrator with `OLLAMA_MODEL`, read the imeng's `HOW_TO_TEST.md` for the models it was tried with, and expect a smaller model to narrate worse and miss more state changes.

Suggested starting point on one GPU machine: the narrator `gemma4:26b` and the judge `actbro/minicpm5-2b-jev:latest` (the shipped imengs' defaults). Ollama context and keep-alive matter for turn latency: see the terminals block in the README.
