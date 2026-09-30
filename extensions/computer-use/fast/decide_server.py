#!/usr/bin/env python3
"""Decision server: GLiNER2.5-Decide behind a localhost-only HTTP endpoint.

Kept as its own process because the model takes ~18s to load and lives in a
separate venv (~/computer-use-work/venv) from the system Python that has the
AT-SPI bindings.

  POST /classify  {"text": str, "tasks": {name: [labels] | {...}}}
       -> {"result": {name: {"label": str, "confidence": float}}, "ms": float}
  GET  /health    -> {"ok": true, "model": str}

Run (GPU):  ~/computer-use-work/venv-rocm/bin/python decide_server.py [port]
Run (CPU):  FASTCU_DECIDE_DEVICE=cpu ~/computer-use-work/venv/bin/python decide_server.py [port]

Measured 2026-09-29 (gpu-bench/): CPU 8 threads 224 ms median; 6900 XT fp16
26.5 ms, 960 MiB. torch ROCm order: cuda:0 = 6900 XT, cuda:1 = 7900 XTX.
The first 4 calls of a process take ~500 ms each, hence the warmup below.
"""
import json, os, sys, time, threading

os.environ.setdefault("HF_HUB_OFFLINE", "1")
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Local directory, not a hub id: weights live with the other models, and the
# server starts with no network and no Hugging Face cache.
MODEL_ID = os.path.expanduser(os.environ.get("FASTCU_DECIDE_MODEL", "~/models/fastino/GLiNER2.5-Decide"))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8377

from gliner2 import AutoExtractor
import torch

t0 = time.time()
DEVICE = os.environ.get("FASTCU_DECIDE_DEVICE", "cuda:0")
DTYPE = os.environ.get("FASTCU_DECIDE_DTYPE", "fp16")
if DEVICE != "cpu" and not torch.cuda.is_available():
    raise SystemExit(f"[decide] {DEVICE} requested but this torch build has no GPU; set FASTCU_DECIDE_DEVICE=cpu")
model = AutoExtractor.from_pretrained(MODEL_ID)
model.eval()
if DEVICE != "cpu":
    model = model.to(DEVICE)
    if DTYPE == "fp16":
        model = model.half()
with torch.inference_mode():
    for i in range(16):
        model.classify_text("warm up the model " * (1 + i % 4), {"target": [f"button: option {j}" for j in range(3 + i)]})
lock = threading.Lock()  # one forward pass at a time; callers are sequential anyway
print(f"[decide] loaded {MODEL_ID} in {time.time()-t0:.1f}s on {next(model.parameters()).device} "
      f"{next(model.parameters()).dtype}, threads={torch.get_num_threads()}, warmed up", flush=True)


class H(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path == "/health":
            p = next(model.parameters())
            return self._send(200, {"ok": True, "model": MODEL_ID, "device": str(p.device), "dtype": str(p.dtype)})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/classify":
            return self._send(404, {"error": "not found"})
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
            t = time.time()
            with lock, torch.inference_mode():
                res = model.classify_text(req["text"], req["tasks"], include_confidence=True)
            ms = 1000 * (time.time() - t)
            print(f"[decide] {ms:.0f}ms {json.dumps(res)[:200]}", flush=True)
            self._send(200, {"result": res, "ms": ms})
        except Exception as e:  # report, never die: the agent treats any error as "no decision"
            print(f"[decide] ERROR {e!r}", flush=True)
            self._send(500, {"error": repr(e)})

    def log_message(self, *a):
        pass


ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
