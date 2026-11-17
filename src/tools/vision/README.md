# Vision worker (host only)

A small Python process the proxy starts when it needs a picture checked: a **pose** check for seat pictures (`seating.photo`) and an **image censor** (`images.safety`). It only runs models and reports what they saw; every rule lives in Node (`src/utils/vision.ts`, `seat-photo.ts`, `image-safety.ts`). It is never in the Docker image (models stay on the host); a container reaches a host worker through `vision.url`.

## Set up once
```bash
python3 -m venv ~/venvs/vision
~/venvs/vision/bin/pip install -r src/tools/vision/requirements.txt
# YOLO-pose weights: download them yourself once, then point at the file (the worker never downloads):
#   e.g. yolov8n-pose.pt from the Ultralytics release page
export VISION_VENV=~/venvs/vision
export VISION_POSE_WEIGHTS=~/models/yolov8n-pose.pt
node scripts/vision-check.mjs some-photo.jpg     # prints what both checks say
```
This project is Apache-2.0. The packages above are optional: you install them into your own venv, and they are not part of this repository or the Docker image. `ultralytics` (and Ultralytics model weights) are AGPL-3.0, which is a different licence from this project's, so check the terms of each package and weight file before you redistribute them or offer the checker to others as a network service. The `nudenet` package carries its own 320n model file.

## In config.json
`vision: {"venv": "${VISION_VENV}", "pose_weights": "${VISION_POSE_WEIGHTS}", "device": "cpu", "idle_stop_s": 120}`. With `device: "cuda"` the proxy runs a check inside the picture GPU lease (the narrator is unloaded meanwhile) and stops the worker after `idle_stop_s` idle seconds so its VRAM is returned (outside production; in production start it yourself and set `vision.url`).
