#!/usr/bin/env python3
"""Probe: can the fast model match a situation to the right rule CONDITION?
Rules here are hand-written stand-ins for what the planner would emit.
Usage: match_probe.py"""
import json, itertools, urllib.request
def decide(text, labels):
    req = urllib.request.Request("http://127.0.0.1:8377/classify", json.dumps({"text": text, "tasks": {"rule": labels}}).encode(), {"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r: return json.load(r)
RULES = ["my health is low and I have healing items", "my health is low and I have no healing items",
         "my health is not low and an enemy is nearby", "no enemies are nearby and loot is nearby",
         "no enemies are nearby and no loot is nearby"]
def truth(h, e, heal, loot):
    if h == "low" and e != "none": return RULES[0] if heal else RULES[1]
    if e != "none": return RULES[2]
    return RULES[3] if loot else RULES[4]
def text(h, e, heal, loot):
    en = {"none": "No enemies are nearby.", "far": "An enemy slime is far away and has not noticed me.", "close": "An enemy slime is close and attacking me."}[e]
    return f"My health is {h}. {en} I have {'healing items' if heal else 'no healing items'}. {'Loot is on the ground close to me.' if loot else 'No loot is nearby.'}"
ok = n = 0; ms = []; miss = []
for h, e, heal, loot in itertools.product(["low", "medium", "high"], ["none", "far", "close"], [True, False], [True, False]):
    if h == "low" and e == "none": continue          # rule table above does not define it
    r = decide(text(h, e, heal, loot), RULES); p = r["result"]["rule"]; ms.append(r["ms"]); n += 1
    if p["label"] == truth(h, e, heal, loot): ok += 1
    else: miss.append((h, e, heal, loot, p["label"], round(p["confidence"], 2)))
ms.sort(); print(f"{ok}/{n} correct; ms median {ms[len(ms)//2]:.1f} max {ms[-1]:.1f}")
for m in miss: print("  MISS", m)
