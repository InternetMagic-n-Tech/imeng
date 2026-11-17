# IMAGES.md: pictures from the chat

Off unless `config.json` has an `images` block. The engine never draws anything itself: it asks a renderer you run on your own machine (ComfyUI, AUTOMATIC1111/Forge, or an OpenAI-style image server such as Open WebUI's). The small judge model writes the picture prompt, code adds your fixed style, and the same seed is used every time for the same character.

## Using it in a chat

| You write | What happens |
|---|---|
| `/draw` | The current scene. |
| `/draw the corridor` | That, in the story's world. |
| `/portrait Bo` | A portrait of the character named Bo (an id or a name; the start of a name works when it is unambiguous). |
| `/portrait Bo` + an attached picture | That picture becomes Bo's reference from then on (PNG, JPEG or WebP). |
| "can you draw me a picture of the lamp" | Only with `images.ask`: the judge offers `Make an image of "the lamp"? Reply yes to make it.` Nothing is drawn until you answer `yes`. |

Nothing is ever drawn without a command or a `yes`. Commands, offers and their replies are notes, not rounds: they never shift the turn count, rollback or edits. Open WebUI shows the picture inline; Discord gets it as an attachment (the bridge fetches it from the proxy).

## Quick start (ComfyUI)

1. Install ComfyUI (below) and get one workflow working in its browser UI.
2. In ComfyUI turn on **Settings > Dev Mode**, then **Save (API Format)** (newer menus: File > Export Workflow (API)). Put the file in the game folder, e.g. `workflow.json`. A normal "Save" will not work.
3. In that file replace the values the engine fills in with placeholders: the positive prompt text `"${positive}"`, the negative `"${negative}"`, the sampler seed `"${seed}"`, and optionally `"${width}"`, `"${height}"`, `"${steps}"`, `"${cfg}"`. A string that is exactly one placeholder keeps its number type, so `"seed": "${seed}"` becomes `"seed": 4242`.
4. For a reference image make a second export (`workflow_reference`) that loads an image (a LoadImage node with `"image": "${reference}"`, then img2img or IP-Adapter). Without it a reference is ignored.
5. Add the block below, run `npm run doctor`, then say `/draw` in a game chat.

```json
"images": {
  "renderer": "comfyui",
  "workflow": "workflow.json",
  "workflow_reference": "workflow-ref.json",
  "size": { "width": 768, "height": 768 },
  "prompts": {
    "style": "35mm film still, grainy, 1998",
    "positive": "highly detailed",
    "negative": "blurry, text, watermark, extra fingers"
  },
  "seeds": { "Bo": 4242 },
  "reference": { "default": "look.png" },
  "ask": { "words": ["picture", "draw me"] },
  "process": { "command": "${COMFY_PYTHON}", "args": ["main.py", "--port", "8188"], "cwd": "${COMFY_DIR}" }
}
```

Every key is in `imeng.schema.json` (and the docs/CONFIGURATION.md table). The final positive prompt is `style, <what the judge wrote>, positive`; `negative` is sent as is. The judge also names the one character a picture is mainly of; that character's seed is used.

## Seeds and references

- **Seed per character.** The first time a character is drawn it gets a seed: `images.seeds` (by actor id or name) if you set one, otherwise a random one. It is then kept for the session and used every time, so renders stay consistent. A scene with no clear main character gets a random seed.
- **Not part of the snapshots.** Seeds and references live beside the state, so going back (regenerate, edit) never changes anyone's face.
- **Reference order for a render:** the character's own reference (a picture sent with `/portrait`, or its first `/portrait` render), else `reference.default`.
- **What a reference is:** a file in the game folder, a picture attached in the chat, or (only with `"reference": {"urls": true}`) an `http(s)` URL. URLs that point at a private or loopback address are refused unless `IMAGE_REF_ALLOW_PRIVATE=1`, and redirects are not followed.
- **Format look-ahead.** Every reference and every result is checked by its first bytes, whatever its name says. Only PNG, JPEG and WebP are used; an SVG, PDF, GIF or anything else is refused with a message (`texts.bad_format`). Size cap: `IMAGE_MAX_BYTES` (10 MB).

## Picture safety (`safety`)

Off unless `images.safety` exists (`{}` turns it on with defaults). The image censor (the vision module: a host-only Python worker, see `src/tools/vision/README.md`, needs the top-level `vision` block; no network) looks at every picture people attach to `/portrait <name>` (or a fetched reference URL) and at every render before it is stored or linked. A label in `labels` at or over `threshold` refuses the picture: the reply is `texts.unsafe`, nothing is stored, nothing is sent on. Pictures from the game folder are not checked (you wrote them). If the detector cannot run (the worker or its venv missing, a file it cannot read) the picture is refused too (`texts.safety_down`): it fails closed.

- `threshold`: 0 to 1, default 0.5 (lower is stricter).
- `labels`: image censor labels that block; default `BUTTOCKS_EXPOSED`, `FEMALE_BREAST_EXPOSED`, `FEMALE_GENITALIA_EXPOSED`, `ANUS_EXPOSED`, `MALE_GENITALIA_EXPOSED`.
- `uploads` / `renders`: check each kind (both default true). Renders matter: img2img and IP-Adapter can bring back what an upload had.
- A detector is probabilistic: it misses things and flags harmless ones. The threshold bounds it; it is not a guarantee. Only one picture per message is read (the first attached); extra attachments are ignored.

## The renderer, and what each one can do

| `renderer` | Seed | Negative prompt | Reference | Notes |
|---|---|---|---|---|
| `comfyui` | yes | yes | yes (`workflow_reference`) | Most flexible; the workflow file is yours. |
| `a1111` | yes | yes | yes (img2img, `strength`) | AUTOMATIC1111 or Forge: start it with `--api`. |
| `openai` | no | sent, often ignored | no | Any `/v1/images/generations` server (Open WebUI's image engine works). |
| `ollama` | no | no | no | Ollama's own image models through the same endpoint. Experimental on Ollama's side (macOS first); unverified here. |

`url` defaults to the usual local port of each (`IMAGE_URL` overrides it).

**Which model.** `images.model` (or env `IMAGE_MODEL`, which wins) picks the checkpoint. A1111/Forge: the `title` or `model_name` from `GET /sdapi/v1/sd-models` (for example `dreamshaper_8.safetensors`), set for each picture without changing the WebUI's own setting; the doctor checks the name against that list. OpenAI-style and Ollama servers: sent as `model`. ComfyUI: put `"${model}"` where your workflow names the checkpoint (a `CheckpointLoaderSimple` node's `ckpt_name`) and set `images.model` to the file name in `models/checkpoints`; without `model` the workflow's own value stays. Files go in `models/Stable-diffusion/` (A1111) or `models/checkpoints/` (ComfyUI).

## The GPU lease (keeps a big narrator and a renderer from fighting over VRAM)

While a picture is being made or waiting:
1. The narrator model (and the judge, when it shares the narrator's Ollama) is **unloaded** with `keep_alive: 0`. The Ollama process is never stopped, and only the models this proxy uses are touched.
2. Every call that needs the narrator waits at a gate, so nothing reloads it mid-render.
3. When the last waiting picture is done the renderer is asked to free its memory (ComfyUI `/free`, A1111 `unload-checkpoint`), then the narrator loads on its next call (the first reply after a picture is slower).

One picture is made at a time; `max_queue` (default 3) is how many may wait before the reply is `texts.queue_full`. `lease.unload_narrator` / `lease.free_renderer` (both default true) turn each half off if you have room for both models. A CPU-only judge (`judge_instance` with `"gpu": false`) is not affected at all.

## `process`: have the engine start the renderer

Optional. If nothing answers at the renderer's address (or `process.ready_url`), the engine runs `command` with `args`, `env` and `cwd`, then waits up to two minutes for it to answer. `${NAME}` in any of those is replaced from the engine's environment; a name that is not set stops the start and says which (the doctor checks this too). The renderer is **left running when the engine exits** (detached) unless `"stop_on_exit": true`. **`venv`** (a folder, `${NAME}` allowed) runs the program as if its Python virtual environment were activated: `VIRTUAL_ENV` set, the venv's `bin` first on `PATH`, and a bare `python`, `python3` or `pip` command replaced by the venv's own. This is applied to the child only (the engine's environment is never changed, so there is nothing to deactivate). With `venv` the program is started through `transparentSpawn` (its output appears in the server log), in its own process group, and **stopped with everything it started when the app gets a kill signal** (Ctrl+C, SIGTERM); set `"stop_on_exit": false` to leave it running instead (then its output is discarded, as without `venv`). The venv must exist (`python3 -m venv <folder>`, or run the renderer's installer once); the doctor warns when it does not. Example: `"process": {"command": "python", "args": ["launch.py", "--api", "--nowebui"], "cwd": "${A1111_DIR}", "venv": "${A1111_DIR}/venv"}`. **Never in production** (`NODE_ENV=production`): there the renderer must already be running, and a picture request says so instead of starting anything. Keep machine-specific paths out of config.json with `${NAME}` variables from `.env` (Backrooms uses `${A1111_DIR}`: set it to your Stable Diffusion WebUI folder and the first `/draw` starts it with `--api --nowebui`).

## Python (only the renderer needs it)

The engine itself is Node. ComfyUI and AUTOMATIC1111 are Python programs; keep them in their own virtual environment, never in the system Python.

```bash
# once, ComfyUI (Python 3.10 to 3.12)
git clone https://github.com/comfyanonymous/ComfyUI ~/ComfyUI
cd ~/ComfyUI
python3 -m venv .venv
. .venv/bin/activate                # Windows: .venv\Scripts\activate
pip install --upgrade pip
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu126   # NVIDIA; pick yours at pytorch.org
pip install -r requirements.txt
python main.py --port 8188          # check http://127.0.0.1:8188 in a browser, then Ctrl-C
```

Put your checkpoint (`.safetensors`) in `~/ComfyUI/models/checkpoints/`. Then point the engine at it without activating anything:

```bash
export COMFY_DIR=~/ComfyUI
export COMFY_PYTHON=~/ComfyUI/.venv/bin/python     # the venv's own python
```

Add `--listen 127.0.0.1` (the default) and never expose the renderer's port: it has no login. For AUTOMATIC1111/Forge follow the same pattern (`python3 -m venv venv`, their `webui.sh --api`).

## Pictures from the state, a refine pass, and a keepsake

Stable Diffusion models understand little language, and the judge that writes the prompt only sees what it is given. Three optional settings in `images` (all off unless written):

- **State into the prompt.** `state_fields` (actor fields, e.g. `["description", "outfit", "gak_colors"]`) and `game_fields` (e.g. `["place"]`) are given to the prompt writer for every actor, beside the usual view. `keep_fields` are values that must appear in that actor's picture: code adds any the judges left out (a recorded colour or outfit is never lost).
- **Refine (`refine`).** A second judge rewrites the prompt as short concrete tags: subject first, things that can be seen, a feeling shown as a look or an action, no names, no negations. Code moves any tag that starts with a negation word (`refine.negations`, default `no`, `not`, `without`, `never`; set your language's words) to the negative prompt. `rules` replaces the default instructions, `max_words` caps the length. If the judge fails the cleaned prompt is used.
- **A different judge.** Refine is the place for a larger model: `refine.judge` `{model, url, api, num_ctx}` (or env `IMAGES_REFINE_JUDGE_MODEL`, `_URL`, `_API`), and `judge` for the prompt writer and the offer (env `IMAGES_JUDGE_*`). On the narrator's own Ollama a bigger model can push the narrator out of VRAM: give it its own `url` (another Ollama or a llama-server), or accept the reload.
- **Keepsake (`keepsake`).** With `goals.reward` `"keepsake"` (see IMENG-MAKING.md) the person who earned it sends `/keepsake` after the show, picks a number and gets one picture, made once. `keepsake.options` is a list of phrases (`{name}`, `{game}` and any actor field are filled in: "social media thumbnail of the happy real winner of {game}", "a small gold trophy engraved {name}") or `"judge"`: a judge proposes `max_options` that fit the setting (`theme`) once, so a game with no social media gets a trophy instead. The picture uses the winner's own seed and reference, so it looks like them. `goals.keepsake_for` is `leader` (default) or `done`.

```json
{
  "images": {
    "renderer": "a1111",
    "state_fields": ["description", "outfit", "gak_colors"],
    "keep_fields": ["gak_colors", "outfit"],
    "refine": { "max_words": 30, "judge": { "model": "qwen3:14b" } },
    "keepsake": { "options": "judge", "theme": "a loud TV quiz show covered in coloured paint", "game": "Quiz Show" }
  },
  "goals": { "reward": "keepsake", "keepsake_for": "leader" }
}
```

## Delivery and the picture address

Pictures are written to `IMAGE_DIR` (default `./images`) under a name made from their content and served at `/images/<name>`. The link uses `PUBLIC_URL` (default `http://localhost:3001`): set it to the address your people reach the proxy at, or the picture will not open for them. The name is the only thing protecting a picture (nobody can list the folder), and the `/images` route needs no API key because a browser must be able to load it.

## Texts

`images.texts` overrides what the server says (`busy`, `queue_full`, `failed`, `bad_format`, `unknown_who`, `no_game`, `unsafe`, `safety_down`, `caption`, `offer_confirm`, `yes`, and for the keepsake `keepsake_not_over`, `keepsake_not_you`, `keepsake_claimed`, `keepsake_pick`, `keepsake_hint`, `keepsake_bad`, `keepsake_none`). `{who}`, `{subject}` and `{kind}` are filled in. `yes` is a comma list of the words that count as yes (default `yes,y,yeah,yep,ok,okay,sure`).

## Environment variables

| Variable | Default | |
|---|---|---|
| `IMAGE_URL` | per renderer | Overrides `images.url`. |
| `IMAGE_MODEL` | none | The checkpoint, over `images.model` (a machine-specific name belongs here, not in a shared config.json). |
| `IMAGE_DIR` | `./images` | Where pictures are stored. |
| `PUBLIC_URL` | `http://localhost:3001` | Base of the picture links. |
| `IMAGE_MAX_BYTES` | `10485760` | Largest picture accepted or stored. |
| `IMAGE_TIMEOUT_MS` | `600000` | One render, and each call to the renderer. |
| `IMAGE_REF_ALLOW_PRIVATE` | off | Allow a reference URL that points at a private address. |
| `IMAGES_JUDGE_MODEL` / `_URL` / `_API` | none | A different judge for the prompt writer and the offer, over `images.judge`. |
| `IMAGES_REFINE_JUDGE_MODEL` / `_URL` / `_API` | none | A different (larger) judge for the refine pass and the keepsake options, over `images.refine.judge`. |

## Limits and honest unknowns

- Nothing here was run against a real ComfyUI, AUTOMATIC1111 or GPU: the renderers are faked in tests. Check the first `/draw` live, and the first reply after it (the narrator's reload time).
- ComfyUI will not render again for an identical prompt and seed (it caches); the same prompt with the same seed returns the cached picture.
- A seed gives repeatable noise, not an identical face: a different prompt or pose changes the picture. References (img2img / IP-Adapter) are what keep a face.
- Pictures are not in the narrator's context: it never sees them.
- The `ollama` and `openai` renderers have no seed, so consistency there comes only from the prompt.
- Not built: multi-picture scenes, a `/draw` that edits the last picture, deleting old files from `IMAGE_DIR` (do it by hand or with a cron job).
