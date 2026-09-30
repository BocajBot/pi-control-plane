#!/usr/bin/env python3
"""Fast computer-use executor: accessibility tree + GLiNER decision + semantic action.

One step = one instruction against ONE named window. No screenshot, no pointer:
  snapshot (AT-SPI)  ->  pick element (GLiNER, ~200ms CPU)  ->  safety gate
  ->  semantic action (AT-SPI do_action / set text)  ->  verify by re-reading state

Outcomes (exactly one per step):
  done      action executed AND postcondition verified by re-reading the tree
  blocked   safety gate refused; nothing was executed
  escalate  no confident/valid target; nothing was executed (caller falls back
            to the planner or the vision loop)
  failed    action executed but verification did not hold

Safety model (every layer must pass; any doubt = no action):
  1. scope      only elements of the one named app+window are ever candidates
  2. lexicon    deterministic destructive-word match on the CHOSEN element's name
  3. judge      LLM risk verdict on the chosen element's name, 3 votes, any
                "risky" wins, cached per name (risk_judge.py). Can only ADD a
                block, never remove one. Unavailable judge = blocked.
  4. approval   a destructive element runs only if the step carries its exact
                name in approve_destructive
  5. payload    typed text is screened by a deny regex
  6. confidence below threshold -> escalate
"""
import json, re, time, urllib.request
import a11y
import risk_judge

DECIDE_URL = "http://127.0.0.1:8377/classify"
PICK_MIN_CONF = 0.90        # fixed a priori (2026-09-29), before any validation run
NONE_LABEL = "none of these controls"
VERIFY_TIMEOUT = 0.25       # seconds to wait for the expected state before calling the step failed

# Deterministic layer. Matches on the element's accessible name.
DESTRUCTIVE = re.compile(
    r"\b(delete|remove|erase|wipe|format|destroy|purge|drop|uninstall|reset|discard|"
    r"overwrite|shut ?down|reboot|power off|pay|payment|purchase|buy|transfer|send money|"
    r"sign out|log ?out|revoke|terminate|kill|empty trash|factory)\b", re.I)
PAYLOAD_DENY = re.compile(r"\brm\s+-|sudo\b|pkexec\b|:\(\)\s*\{|mkfs\b|dd\s+if=|shutdown\b|reboot\b|curl[^|]*\|\s*(ba)?sh", re.I)


def decide(text, tasks):
    req = urllib.request.Request(DECIDE_URL, json.dumps({"text": text, "tasks": tasks}).encode(),
                                 {"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def run_step(step, app, title, log=None):
    """step: {instruction, kind: click|set_text|check|uncheck, text?, target?, approve_destructive?: [names]}

    target (optional, from a planner that saw the tree): exact control name.
    GLiNER still picks independently from `instruction`; the two must name the
    same control or the step escalates. Agreement replaces the confidence
    floor, which exists for the case where GLiNER is the only picker.
    """
    t0 = time.time()
    rec = {"step": step, "outcome": None, "reason": None, "element": None, "timing_ms": {}}

    def finish(outcome, reason):
        rec["outcome"], rec["reason"] = outcome, reason
        rec["timing_ms"]["total"] = round(1000 * (time.time() - t0), 1)
        if log:
            with open(log, "a") as f:
                f.write(json.dumps(rec) + "\n")
        return rec

    kind = step.get("kind")
    if kind not in ("click", "set_text", "check", "uncheck"):
        return finish("escalate", f"unknown step kind {kind!r}")
    if kind == "set_text":
        if not isinstance(step.get("text"), str):
            return finish("escalate", "set_text without text")
        if PAYLOAD_DENY.search(step["text"]):
            return finish("blocked", "payload matches deny pattern")

    # 1. scope
    t = time.time()
    win = a11y.find_window(app, title)
    if win is None:
        return finish("escalate", f"window {app!r}/{title!r} not in accessibility tree")
    els, skipped = a11y.snapshot(win)
    if skipped:
        return finish("escalate", f"accessibility tree incomplete ({skipped} unreadable nodes)")
    rec["timing_ms"]["snapshot"] = round(1000 * (time.time() - t), 1)
    # only elements that can perform this kind of step
    if kind == "set_text":
        cands = [e for e in els if e.states["editable"]]
    elif kind in ("check", "uncheck"):
        cands = [e for e in els if e.role in ("check box", "toggle button", "radio button")]
    else:
        cands = [e for e in els if "click" in e.actions]
    if not cands:
        return finish("escalate", "no candidate elements for this step kind")
    labels = {}
    for e in cands:
        if e.label in labels:
            return finish("escalate", f"ambiguous tree: two elements labelled {e.label!r}")
        labels[e.label] = e

    # pick
    t = time.time()
    try:
        d = decide(step["instruction"], {"target": list(labels) + [NONE_LABEL]})
        pick = d["result"]["target"]
    except Exception as ex:
        return finish("escalate", f"decision server error: {ex!r}")
    rec["timing_ms"]["pick"] = round(1000 * (time.time() - t), 1)
    rec["pick"] = pick
    if pick["label"] == NONE_LABEL or pick["label"] not in labels:
        return finish("escalate", "model chose no control")
    el = labels[pick["label"]]
    if step.get("target") is not None:
        if el.name != step["target"]:
            return finish("escalate", f"planner named {step['target']!r} but picker chose {el.name!r}")
    elif pick["confidence"] < PICK_MIN_CONF:
        return finish("escalate", f"confidence {pick['confidence']:.3f} < {PICK_MIN_CONF}")
    rec["element"] = el.to_json()

    # 2-4. safety gate on the chosen element
    approved = el.name in (step.get("approve_destructive") or [])
    lex = bool(DESTRUCTIVE.search(el.name))
    r = risk_judge.judge(el.name, el.role)
    rec["timing_ms"]["risk"] = r["ms"]
    rec["risk"] = {"lexicon": lex, "judge": r}
    risky = lex or r["risky"]
    if risky and not approved:
        return finish("blocked", f"destructive control {el.name!r} without approval "
                                 f"(lexicon={lex}, judge={r['risky']}: {r['reason']})")

    # execute. The node was captured before two model calls; if the widget is
    # gone by now the call raises, and that is a recorded outcome, not a crash.
    t = time.time()
    before_checked = el.states["checked"]
    try:
        if kind == "set_text":
            a11y.set_text(el, step["text"])
        elif kind in ("check", "uncheck"):
            want = kind == "check"
            if before_checked != want:
                a11y.invoke(el)
        else:
            a11y.invoke(el)
    except Exception as ex:
        return finish("failed", f"action raised {ex!r}")
    rec["timing_ms"]["act"] = round(1000 * (time.time() - t), 1)

    # verify by re-reading state (never trust the action's return value).
    # Poll until the expected state shows or VERIFY_TIMEOUT passes: a fixed
    # 50 ms wait here was most of a GPU-picked step.
    t = time.time()
    ok, why = True, "executed"
    try:
        while kind != "click":
            if kind == "set_text":
                got = a11y.get_text(el)
                ok, why = got == step["text"], f"field reads {got!r}"
            else:
                st = el.node.get_state_set()
                checked = st.contains(a11y.Atspi.StateType.CHECKED)
                ok, why = checked == (kind == "check"), f"checked={checked}"
            if ok or time.time() - t > VERIFY_TIMEOUT:
                break
            time.sleep(0.002)
    except Exception as ex:
        ok, why = False, f"verification raised {ex!r}"
    rec["timing_ms"]["verify"] = round(1000 * (time.time() - t), 1)
    return finish("done" if ok else "failed", why)


if __name__ == "__main__":
    import sys
    app, title, step = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
    print(json.dumps(run_step(step, app, title), indent=1))
