#!/usr/bin/env python3
"""Drop-in picker server with decide_server.py's contract, backed by Laya (convaiinnovations/laya) instead of GLiNER.
  POST /classify {"text": instruction, "tasks": {"target": [labels...]}} -> {"result": {"target": {"label", "confidence"}}}
  GET  /health
Run from the laya venv:  ~/laya-work/.venv/bin/python laya_server.py   (same port 8377; stop decide_server.py first)
Zero-shot Laya lost to GLiNER on the test app (held-out 20/26 vs 26/26, 2026-09-29); this exists to try it on real apps.
"""
import json, os, time
from http.server import BaseHTTPRequestHandler, HTTPServer
import torch, laya

PORT = int(os.environ.get("FASTCU_DECIDE_PORT", 8377))
CKPT = os.environ.get("FASTCU_LAYA_CKPT", "convaiinnovations/laya")
agent = laya.load(CKPT, device=os.environ.get("FASTCU_DECIDE_DEVICE", "cuda:1"))
NONE = "none of these controls"

def describe(label):
    if label == NONE: return "no listed control matches the instruction"
    kind, _, name = label.partition(": ")
    return f"the '{name}' {kind}" if name else label

def pick(text, labels):
    qs = {"target": {"type": "choice", "instructions": "Which UI control does the instruction ask to operate?",
                     "criteria": {l: describe(l) for l in labels}}}
    a = agent.predict({"instruction": text}, qs)["answers"]["target"]
    return {"label": a["choice"], "confidence": float(a["probabilities"][a["choice"]])}

for i in range(8):                                             # warm-up so the first real pick is not an outlier
    pick("warm up", [f"button: option {j}" for j in range(3 + i)] + [NONE])

class H(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        self._send(200, {"ok": True, "model": CKPT, "device": str(agent.device)} if self.path == "/health" else {"error": "not found"})
    def do_POST(self):
        if self.path != "/classify": return self._send(404, {"error": "not found"})
        try:
            req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            t = time.perf_counter()
            res = {name: pick(req["text"], labels) for name, labels in req["tasks"].items()}
            self._send(200, {"result": res, "ms": round(1000 * (time.perf_counter() - t), 1)})
        except Exception as e:
            self._send(500, {"error": repr(e)})
    def log_message(self, *a): pass

print(f"laya picker on 127.0.0.1:{PORT} ({CKPT})", flush=True)
HTTPServer(("127.0.0.1", PORT), H).serve_forever()
