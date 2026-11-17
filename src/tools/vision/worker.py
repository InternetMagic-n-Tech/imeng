#!/usr/bin/env python3
"""The vision worker: a long-lived child of the Node proxy (src/utils/vision.ts), host only.

Protocol: one JSON object per line on stdin, one JSON object per line on stdout (stderr is for logs).
  {"id": 1, "op": "ping"}                              -> {"id": 1, "ok": true}
  {"id": 2, "op": "pose",   "image": "<base64>"}       -> {"id": 2, "ok": true, "people": [{"score": 0.9, "keypoints": [[x, y, confidence] x 17]}]}
  {"id": 3, "op": "censor", "image": "<base64>"}       -> {"id": 3, "ok": true, "hits": [{"label": "FACE_FEMALE", "score": 0.8}]}
  anything that goes wrong                              -> {"id": N, "ok": false, "error": "..."}
This file only runs models and reports what they saw. Every rule (how many people, which keypoints, which labels block, thresholds, texts) lives in Node.
Environment: VISION_DEVICE (cpu or cuda, default cpu), VISION_POSE_WEIGHTS (a local YOLO-pose weights file; never downloaded: no outbound network).
"""
import base64
import io
import json
import os
import sys
import traceback

DEVICE = os.environ.get("VISION_DEVICE", "cpu")
WEIGHTS = os.environ.get("VISION_POSE_WEIGHTS", "")
_pose = None
_censor = None


def image(b64):
    from PIL import Image
    return Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")


def pose_model():
    global _pose
    if _pose is None:
        if not WEIGHTS or not os.path.isfile(WEIGHTS):
            raise RuntimeError("VISION_POSE_WEIGHTS is not a file (weights are never downloaded here)")
        from ultralytics import YOLO, settings
        try:
            settings.update({"sync": False})  # no analytics, no outbound calls
        except Exception:
            pass
        _pose = YOLO(WEIGHTS)
    return _pose


def censor_model():
    global _censor
    if _censor is None:
        from nudenet import NudeDetector
        _censor = NudeDetector()
    return _censor


def do_pose(b64):
    r = pose_model().predict(image(b64), device=DEVICE, verbose=False)[0]
    people = []
    if r.keypoints is not None and r.boxes is not None and len(r.boxes) > 0:
        xy = r.keypoints.xy.cpu().numpy()
        conf = r.keypoints.conf.cpu().numpy() if r.keypoints.conf is not None else None
        scores = r.boxes.conf.cpu().numpy()
        for i in range(len(scores)):
            kp = [[float(xy[i][j][0]), float(xy[i][j][1]), float(conf[i][j]) if conf is not None else 1.0] for j in range(len(xy[i]))]
            people.append({"score": float(scores[i]), "keypoints": kp})
    return {"people": people}


def do_censor(b64):
    import numpy as np
    arr = np.array(image(b64))[:, :, ::-1]  # RGB to BGR, the layout the detector expects
    return {"hits": [{"label": str(d["class"]), "score": float(d["score"])} for d in censor_model().detect(arr)]}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            msg = json.loads(line)
            rid = msg.get("id")
            op = msg.get("op")
            if op == "ping":
                out = {}
            elif op == "pose":
                out = do_pose(msg["image"])
            elif op == "censor":
                out = do_censor(msg["image"])
            else:
                raise ValueError("unknown op: %r" % (op,))
            out.update({"id": rid, "ok": True})
        except Exception as e:  # reported to Node, which decides what a failure means (it fails closed)
            traceback.print_exc(file=sys.stderr)
            out = {"id": rid, "ok": False, "error": str(e)[:300]}
        sys.stdout.write(json.dumps(out) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
