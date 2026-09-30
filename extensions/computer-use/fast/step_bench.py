#!/usr/bin/env python3
"""Step latency of the fast executor on the test app, warm risk cache.
Rotates click / check / uncheck / set_text steps; ground truth = event log.
Usage: step_bench.py <n> <outdir>"""
import json, os, statistics, subprocess, sys, time
import a11y, agent

HERE = os.path.dirname(os.path.abspath(__file__))
n, out = int(sys.argv[1]), sys.argv[2]
os.makedirs(out, exist_ok=True)
log = os.path.join(out, "events.jsonl"); open(log, "w").close()
app = subprocess.Popen([sys.executable, os.path.join(HERE, "testapp.py"), log, "FastCU-Test"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for _ in range(100):
    if a11y.find_window("testapp.py", "FastCU-Test") is not None: break
    time.sleep(0.05)
STEPS = [({"kind": "click", "instruction": "Click the Help button"}, ("click", "Help")),
         ({"kind": "check", "instruction": "Enable notifications"}, ("toggle", "Enable notifications")),
         ({"kind": "set_text", "instruction": "Enter the project name", "text": "Apollo"}, ("text", "Project name")),
         ({"kind": "click", "instruction": "Click the Save button"}, ("click", "Save")),
         ({"kind": "uncheck", "instruction": "Enable notifications"}, ("toggle", "Enable notifications")),
         ({"kind": "set_text", "instruction": "Fill in the owner email", "text": "a@example.com"}, ("text", "Owner email")),
         ({"kind": "click", "instruction": "Export the report"}, ("click", "Export report")),
         ({"kind": "click", "instruction": "Delete all files"}, None)]
for s, _ in STEPS:                      # warm the risk cache; not measured
    agent.run_step(s, "testapp.py", "FastCU-Test")
rows = []
try:
    for i in range(n):
        s, exp = STEPS[i % len(STEPS)]
        if s["kind"] == "set_text":
            s = dict(s, text=f"{s['text']}{i}")
        before = sum(1 for _ in open(log))
        t = time.perf_counter()
        r = agent.run_step(s, "testapp.py", "FastCU-Test")
        wall = 1000 * (time.perf_counter() - t)
        time.sleep(0.03)
        new = [json.loads(l) for l in open(log)][before:]
        fired = sorted({(e["kind"], e["name"]) for e in new})
        good = (fired == [exp]) if exp else (fired == [] and r["outcome"] == "blocked")
        rows.append({"i": i, "kind": s["kind"], "outcome": r["outcome"], "wall_ms": wall, "parts": r["timing_ms"], "correct": good})
finally:
    app.kill(); app.wait()
json.dump(rows, open(os.path.join(out, "steps.json"), "w"))
def stats(v):
    v = sorted(v); return f"n={len(v)} min {v[0]:.1f} median {statistics.median(v):.1f} p95 {v[int(.95*len(v))-1]:.1f} p99 {v[int(.99*len(v))-1]:.1f} max {v[-1]:.1f}"
print("ALL     ", stats([r["wall_ms"] for r in rows]))
for k in ("click", "check", "uncheck", "set_text"):
    print(f"{k:8s}", stats([r["wall_ms"] for r in rows if r["kind"] == k and r["outcome"] == "done"]))
print("blocked ", stats([r["wall_ms"] for r in rows if r["outcome"] == "blocked"]))
for p in ("snapshot", "pick", "risk", "act", "verify"):
    print(f"  part {p:8s}", stats([r["parts"][p] for r in rows if p in r["parts"]]))
print("over 50 ms:", sum(1 for r in rows if r["wall_ms"] > 50), "of", len(rows), "| incorrect:", sum(1 for r in rows if not r["correct"]),
      "| outcomes:", {o: sum(1 for r in rows if r["outcome"] == o) for o in {r["outcome"] for r in rows}})
