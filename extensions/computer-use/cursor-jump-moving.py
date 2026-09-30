#!/usr/bin/env python3
"""Cursor-jump test, user-moving variant.

Two instruments, run together through baseline / run / after / control:
  1. core pointer position sampled every ~22ms (unshimmed xdotool)
  2. raw XI2 events by SOURCE DEVICE (`xinput test-xi2 --root`)
Findings:
  - core-XTEST events during the run  -> agent input leaked onto the user's cursor
  - agent-XTEST events during the run -> engagement proof (agent really used its own master)
  - position step > STEP px with no physical raw motion in the prior 60ms -> warp
Positive control: one unshimmed xdotool warp of the core pointer (+300px and
back); both instruments must flag it.

Usage: cursor-jump-moving.py <out-prefix>
"""
import json, math, os, re, subprocess, sys, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
JITI = os.path.expanduser("~/.pi/agent/npm/node_modules/.bin/jiti")
ENV = {k: v for k, v in os.environ.items() if k not in ("LD_PRELOAD", "CU_CLIENT_POINTER")}
STEP = 150
out = sys.argv[1]
samples, events, names, phase, stop = [], [], {}, ["baseline"], threading.Event()

def sh(*a, **k):
    return subprocess.run(a, env=ENV, capture_output=True, text=True, timeout=10, **k).stdout

def loc():
    d = dict(l.split("=") for l in sh("xdotool", "getmouselocation", "--shell").split())
    return int(d["X"]), int(d["Y"])

def learn_names():
    for l in sh("xinput", "list", "--short").splitlines():
        m = re.match(r"^[\s⎡⎣⎜│↳]*(.+?)\s+id=(\d+)", l)
        if m: names[int(m.group(2))] = m.group(1).strip()

def sampler():
    while not stop.is_set():
        x, y = loc(); samples.append((time.time(), phase[0], x, y)); time.sleep(0.02)

raw = open(out + ".xi2.log", "w")
xi = subprocess.Popen(["stdbuf", "-oL", "xinput", "test-xi2", "--root"], env=ENV, stdout=subprocess.PIPE, text=True)
def reader():
    cur = None
    for line in xi.stdout:
        raw.write(line)
        m = re.match(r"EVENT type \d+ \((\w+)\)", line)
        if m: cur = m.group(1); continue
        m = re.match(r"\s+device: (\d+) \((\d+)\)", line)
        if m and cur and cur.startswith("Raw"):
            events.append((time.time(), phase[0], cur, int(m.group(2)))); cur = None

learn_names()
threading.Thread(target=reader, daemon=True).start()
t = threading.Thread(target=sampler); t.start()
subprocess.run(["notify-send", "-u", "critical", "-t", "4000", "Cursor test", "START moving the mouse now, keep moving"], env=ENV)
time.sleep(5)
phase[0] = "run"
env = dict(ENV, DEMO_TARGET="zenity", COMPUTER_USE_MODEL="nex-n25-mini:think", COMPUTER_USE_SCALE_W="1920", COMPUTER_USE_MAX_TOKENS="2048")
demo = subprocess.Popen([JITI, "demo.ts"], cwd=HERE, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
time.sleep(2.5); learn_names()          # CU-Agent devices exist only during the run
demo_out = demo.communicate(timeout=300)[0]
phase[0] = "after"
time.sleep(5)
phase[0] = "control"
x0, y0 = loc()
sh("xdotool", "mousemove", str(x0 + 300 if x0 < 3000 else x0 - 300), str(y0))
time.sleep(0.3)
sh("xdotool", "mousemove", str(x0), str(y0))
time.sleep(0.5)
stop.set(); t.join(); xi.terminate(); time.sleep(0.2); raw.close()
subprocess.run(["notify-send", "-t", "4000", "Cursor test", "DONE, you can stop"], env=ENV)

art = [l.split("artifacts: ")[1] for l in demo_out.splitlines() if "artifacts: " in l]
clicks = []
if art:
    for s in json.load(open(os.path.join(art[0], "trace.json")))["steps"]:
        if s["delivered_pointer"]: clicks.append((s["delivered_pointer"]["x"], s["delivered_pointer"]["y"]))

def kind(dev):
    n = names.get(dev, f"unknown-{dev}")
    if n == "Virtual core XTEST pointer": return "core_xtest"
    if n.startswith("CU-Agent"): return "agent_xtest"
    if "XTEST" in n: return "other_xtest"
    return "physical"

phys = [e[0] for e in events if kind(e[3]) == "physical" and e[2] == "RawMotion"]
report = {"demo_verdict": [l for l in demo_out.splitlines() if "verdict" in l], "agent_clicks": clicks,
          "devices_seen": sorted({f"{e[3]}:{names.get(e[3], '?')}" for e in events}), "phases": {}}
for ph in ("baseline", "run", "after", "control"):
    rows = [s for s in samples if s[1] == ph]
    pairs = list(zip(rows, rows[1:]))
    steps = [math.hypot(b[2] - a[2], b[3] - a[3]) for a, b in pairs]
    big = [(a, b, s) for (a, b), s in zip(pairs, steps) if s > STEP]
    unexplained = [{"from": a[2:], "to": b[2:], "px": round(s, 1)} for a, b, s in big
                   if not any(a[0] - 0.06 <= p <= b[0] for p in phys)]
    ev = {}
    for e in events:
        if e[1] == ph: k = f"{kind(e[3])}:{e[2]}"; ev[k] = ev.get(k, 0) + 1
    near = min((math.hypot(r[2] - cx, r[3] - cy) for r in rows for cx, cy in clicks), default=None)
    report["phases"][ph] = {"samples": len(rows), "distinct_positions": len({(r[2], r[3]) for r in rows}),
        "path_px": round(sum(steps)), "max_step_px": round(max(steps), 1) if steps else None,
        f"steps_over_{STEP}px": len(big), "steps_without_physical_motion": unexplained,
        "min_dist_to_agent_click_px": round(near, 1) if near is not None else None, "raw_events": ev}
json.dump({"report": report, "samples": samples, "events": events, "names": names}, open(out + ".json", "w"))
print(json.dumps(report, indent=1))
