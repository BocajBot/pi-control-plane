#!/usr/bin/env python3
"""Offline policy eval: can the fast model pick a game behavior from
objective + situation text? No game involved.
Usage: policy_eval.py <dev|heldout> <framing> [<framing>...]"""
import json, os, sys, time, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__))
D = json.load(open(os.path.join(HERE, "policy_cases.json")))
FRAMINGS = {
    "plain": lambda o, s: f"Objective: {o}\nSituation: {s}",
    "situation-first": lambda o, s: f"{s} My orders: {o} What should I do now?",
    "question": lambda o, s: f"I am playing a game. My orders are: {o} Right now: {s} Which action follows my orders?",
}
def decide(text, labels):
    req = urllib.request.Request("http://127.0.0.1:8377/classify", json.dumps({"text": text, "tasks": {"behavior": labels}}).encode(), {"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)
split = sys.argv[1]
for f in sys.argv[2:]:
    ok, ms, miss = 0, [], []
    for c in D[split]:
        r = decide(FRAMINGS[f](c["objective"], c["situation"]), D["behaviors"])
        b = r["result"]["behavior"]; ms.append(r["ms"])
        if b["label"] in c["expect"]: ok += 1
        else: miss.append((c["objective"][:38], c["situation"][:70], b["label"], round(b["confidence"], 2)))
    ms.sort()
    print(f"{f}: {ok}/{len(D[split])} correct; model ms median {ms[len(ms)//2]:.1f} max {ms[-1]:.1f}")
    for m in miss: print("   MISS", m)
