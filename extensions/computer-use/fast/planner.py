#!/usr/bin/env python3
"""Planner: slow LLM, called ONCE per goal. Sees the control list as text (no
screenshot) and emits an ordered step list. Every step is then run by the
fast executor (agent.run_step), which owns all safety decisions.

Invariants:
  - the planner's output schema has NO approval field; approvals come only
    from the caller and are attached here, after planning
  - `target` is grammar-constrained to names that exist in the snapshot
  - the executor cross-checks each step: GLiNER must independently pick the
    same control from the step's natural-language instruction, or the step
    escalates (two models must agree before anything is pressed)
  - first step that is not `done` stops the plan: later steps assumed state
    that did not happen
"""
import json, os, sys, time, urllib.request
import a11y, agent

BASE_URL = os.environ.get("COMPUTER_USE_BASE_URL", "http://localhost:9292/v1")
MODEL = os.environ.get("FASTCU_PLANNER_MODEL", "nex-n25-mini:think")
MAX_STEPS = 8
SYSTEM = (
    "You plan user-interface automation. You are given a goal and the list of controls in one window. "
    "Produce the shortest ordered list of steps that achieves the goal using ONLY the listed controls. "
    "Each step acts on exactly one control: kind 'click' for buttons, 'check' or 'uncheck' for check boxes, "
    "'set_text' for text fields. 'text' is the exact text to enter for set_text and an empty string otherwise. "
    "'instruction' is one short plain sentence saying what the step does, and it must mention the control "
    "by its name (for example: Click the OK button to close the dialog). "
    "Do ONLY what the goal asks. Never add a step the goal did not ask for: do not save, apply, confirm, "
    "close or submit unless the goal says so. "
    "If part of the goal cannot be done with the listed controls, leave that part out. "
    "If nothing can be done, return an empty list."
)


def plan(goal, elements):
    names = sorted({e.name for e in elements})
    schema = {"type": "object", "additionalProperties": False, "required": ["steps"], "properties": {"steps": {
        "type": "array", "maxItems": MAX_STEPS, "items": {
            "type": "object", "additionalProperties": False, "required": ["kind", "target", "instruction", "text"],
            "properties": {"kind": {"type": "string", "enum": ["click", "check", "uncheck", "set_text"]},
                           "target": {"type": "string", "enum": names},
                           "instruction": {"type": "string", "maxLength": 120},
                           "text": {"type": "string", "maxLength": 200}}}}}}
    listing = "\n".join(f"- {e.label}" + (" (checked)" if e.states["checked"] else "") for e in elements)
    body = {"model": MODEL, "temperature": 0, "max_tokens": 3000,
            "messages": [{"role": "system", "content": SYSTEM},
                         {"role": "user", "content": f"Controls:\n{listing}\n\nGoal: {goal}"}],
            "response_format": {"type": "json_schema", "json_schema": {"name": "plan", "schema": schema, "strict": True}}}
    t = time.time()
    # Thinking can consume the whole budget and leave no answer (seen 2/36,
    # finish_reason=length). One retry; a second empty answer escalates.
    for attempt in (1, 2):
        req = urllib.request.Request(f"{BASE_URL}/chat/completions", json.dumps(body).encode(), {"content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=180) as r:
            data = json.load(r)
        content = data["choices"][0]["message"].get("content") or ""
        if content.strip():
            break
    else:
        raise RuntimeError(f"planner returned no content twice (finish_reason={data['choices'][0].get('finish_reason')})")
    return json.loads(content)["steps"], round(1000 * (time.time() - t), 1)


def run_goal(goal, app, title, approve=(), log=None):
    rec = {"goal": goal, "approve": list(approve), "plan": None, "plan_ms": None, "steps": [], "outcome": None, "reason": None}
    t0 = time.time()
    win = a11y.find_window(app, title)
    if win is None:
        rec.update(outcome="escalate", reason="window not in accessibility tree")
        return rec
    els, skipped = a11y.snapshot(win)
    if skipped:
        rec.update(outcome="escalate", reason=f"accessibility tree incomplete ({skipped} unreadable nodes)")
        return rec
    try:
        steps, rec["plan_ms"] = plan(goal, els)
    except Exception as ex:
        rec.update(outcome="escalate", reason=f"planner failed: {ex!r}")
        return rec
    rec["plan"] = steps
    rec["outcome"], rec["reason"] = "done", f"{len(steps)} steps"
    if not steps:
        rec["outcome"], rec["reason"] = "escalate", "planner produced no steps"
    for s in steps:
        step = {"kind": s["kind"], "instruction": s["instruction"], "target": s["target"],
                "approve_destructive": list(approve)}   # caller's approvals only
        if s["kind"] == "set_text":
            step["text"] = s["text"]
        r = agent.run_step(step, app, title, log=log)
        rec["steps"].append({k: r[k] for k in ("outcome", "reason", "timing_ms")} | {"step": s, "pick": r.get("pick")})
        if r["outcome"] != "done":
            rec["outcome"], rec["reason"] = r["outcome"], f"stopped at step {len(rec['steps'])}: {r['reason']}"
            break
    rec["total_ms"] = round(1000 * (time.time() - t0), 1)
    rec["exec_ms"] = round(sum(s["timing_ms"].get("total", 0) for s in rec["steps"]), 1)
    return rec


if __name__ == "__main__":
    print(json.dumps(run_goal(sys.argv[3], sys.argv[1], sys.argv[2], approve=json.loads(sys.argv[4]) if len(sys.argv) > 4 else []), indent=1))
