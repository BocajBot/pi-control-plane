#!/usr/bin/env python3
"""Cursor-jump test: does a computer-use run move the USER's (core) cursor?

Samples the core pointer (unshimmed `xdotool getmouselocation`) every ~25ms
through four phases: baseline, live demo run, after restore, positive control.
A jump = a large step between consecutive samples, or the core pointer
landing on a point the agent clicked. The positive control warps the core
pointer by a known amount and back; the sampler must see it or the
instrument is blind.

Usage: cursor-jump-test.py <out.json>   (needs DISPLAY/XAUTHORITY)
"""
import json, math, os, subprocess, sys, threading, time, glob

HERE = os.path.dirname(os.path.abspath(__file__))
JITI = os.path.expanduser("~/.pi/agent/npm/node_modules/.bin/jiti")
ENV = {k: v for k, v in os.environ.items() if k not in ("LD_PRELOAD", "CU_CLIENT_POINTER")}
samples, phase, stop = [], ["baseline"], threading.Event()

def loc():
    o = subprocess.run(["xdotool", "getmouselocation", "--shell"], env=ENV, capture_output=True, text=True, timeout=5).stdout
    d = dict(l.split("=") for l in o.split())
    return int(d["X"]), int(d["Y"])

def sampler():
    while not stop.is_set():
        x, y = loc()
        samples.append((time.time(), phase[0], x, y))
        time.sleep(0.02)

t = threading.Thread(target=sampler); t.start()
time.sleep(3)
phase[0] = "run"
env = dict(ENV, DEMO_TARGET="zenity", COMPUTER_USE_MODEL="nex-n25-mini:think", COMPUTER_USE_SCALE_W="1920", COMPUTER_USE_MAX_TOKENS="2048")
demo = subprocess.run([JITI, "demo.ts"], cwd=HERE, env=env, capture_output=True, text=True, timeout=300)
phase[0] = "after"
time.sleep(3)
phase[0] = "control"
x0, y0 = loc()
subprocess.run(["xdotool", "mousemove", str(x0 + 300 if x0 < 3000 else x0 - 300), str(y0)], env=ENV, timeout=5)
time.sleep(0.3)
subprocess.run(["xdotool", "mousemove", str(x0), str(y0)], env=ENV, timeout=5)
time.sleep(0.3)
stop.set(); t.join()

art = [l.split("artifacts: ")[1] for l in demo.stdout.splitlines() if "artifacts: " in l]
clicks = []
if art:
    for s in json.load(open(os.path.join(art[0], "trace.json")))["steps"]:
        if s["delivered_pointer"]: clicks.append((s["delivered_pointer"]["x"], s["delivered_pointer"]["y"]))

report = {"demo_verdict": [l for l in demo.stdout.splitlines() if "verdict" in l], "agent_clicks": clicks, "phases": {}}
for ph in ("baseline", "run", "after", "control"):
    rows = [s for s in samples if s[1] == ph]
    steps = [math.hypot(b[2] - a[2], b[3] - a[3]) for a, b in zip(rows, rows[1:])]
    # include the phase boundary: last sample of the previous phase -> first of this one
    near = min((math.hypot(r[2] - cx, r[3] - cy) for r in rows for cx, cy in clicks), default=None)
    report["phases"][ph] = {
        "samples": len(rows),
        "median_interval_ms": round(1000 * sorted(b[0] - a[0] for a, b in zip(rows, rows[1:]))[len(rows) // 2 - 1], 1) if len(rows) > 2 else None,
        "distinct_positions": len({(r[2], r[3]) for r in rows}),
        "first": rows[0][2:] if rows else None, "last": rows[-1][2:] if rows else None,
        "max_step_px": round(max(steps), 1) if steps else None,
        "steps_over_100px": sum(1 for s in steps if s > 100),
        "min_dist_to_agent_click_px": round(near, 1) if near is not None else None,
    }
bounds = []
for a, b in zip(samples, samples[1:]):
    if a[1] != b[1]: bounds.append({"from": a[1], "to": b[1], "step_px": round(math.hypot(b[2] - a[2], b[3] - a[3]), 1)})
report["phase_boundary_steps"] = bounds
json.dump({"report": report, "samples": samples}, open(sys.argv[1], "w"))
print(json.dumps(report, indent=1))
