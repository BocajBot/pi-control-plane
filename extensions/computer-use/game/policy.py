#!/usr/bin/env python3
"""Policy compiler + runtime.

compile_policy(objective): slow planner LLM, ONCE per objective. Emits an
  ordered rule table over discrete state features; first matching rule wins.
decide(table, features): runtime, deterministic, microseconds. No model.

Rationale (2026-09-29, offline evals in this directory): no fast model could
apply conditions reliably. GLiNER 4/10 direct and 22/32 matching (ignores
negation); 0.8B-4B LLMs 4-6/10 at 150-236 ms.
"""
import json, os, re, sys, time, urllib.request

BASE_URL = os.environ.get("COMPUTER_USE_BASE_URL", "http://localhost:9292/v1")
PLANNER = os.environ.get("FASTCU_PLANNER_MODEL", "Qwen3.8-27B-Q4_1")
BEHAVIORS = ["attack the nearest enemy", "retreat away from enemies", "use a healing item",
             "explore to find enemies", "pick up the loot", "stand still and wait"]
FEATURES = {"health": ["low", "medium", "high"],
            "enemy": ["none", "far", "medium", "close"],
            "attacked": ["yes", "no"],
            "healing_items": ["yes", "no"],
            "loot": ["yes", "no"]}
SYSTEM = (
    "You compile a player's orders for a game character into a decision table. "
    "The game state has these features: "
    "health (low, medium, high); enemy = distance of the nearest enemy (none, far, medium, close); "
    "attacked = an enemy is attacking the character (yes, no); healing_items = the character has healing items (yes, no); "
    "loot = loot is on the ground nearby (yes, no). "
    "Write an ORDERED list of rules. Each rule lists, per feature, the values for which it applies "
    "(list every value if the feature does not matter) and the single action to take. "
    "The first rule whose conditions all match is used, so put the most urgent and most specific rules first. "
    "The last rule must apply to every state. Cover every situation; follow the orders exactly, including what they forbid. "
    "Also fill target_words: the creature words the orders single out as the ones to fight or collect from "
    "(singular, lower case, for example slime). Leave target_words empty when the orders speak of enemies in general. "
    "Actions: " + "; ".join(BEHAVIORS) + "."
)
SCHEMA = {"type": "object", "additionalProperties": False, "required": ["target_words", "rules"], "properties": {
    "target_words": {"type": "array", "maxItems": 6, "items": {"type": "string", "pattern": "^[a-z]{3,20}$"}},
    "rules": {
    "type": "array", "minItems": 1, "maxItems": 12, "items": {
        "type": "object", "additionalProperties": False, "required": ["why"] + list(FEATURES) + ["action"],
        "properties": {"why": {"type": "string", "maxLength": 80},
                       **{k: {"type": "array", "minItems": 1, "items": {"type": "string", "enum": v}} for k, v in FEATURES.items()},
                       "action": {"type": "string", "enum": BEHAVIORS}}}}}}


def compile_policy(objective, model=None):
    body = {"model": model or PLANNER, "temperature": 0, "max_tokens": 6000,
            "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": "Orders: " + objective}],
            "response_format": {"type": "json_schema", "json_schema": {"name": "policy", "schema": SCHEMA, "strict": True}}}
    t = time.time()
    req = urllib.request.Request(f"{BASE_URL}/chat/completions", json.dumps(body).encode(), {"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=900) as r:
        d = json.load(r)
    out = json.loads(d["choices"][0]["message"]["content"])
    rules = out["rules"]
    # the table must be total: a state with no rule would leave the character without a decision
    last = rules[-1]
    if any(set(last[k]) != set(v) for k, v in FEATURES.items()):
        rules.append({"why": "fallback added by harness: planner's last rule was not universal",
                      **{k: list(v) for k, v in FEATURES.items()}, "action": "stand still and wait"})
    return {"objective": objective, "model": model or PLANNER, "compile_s": round(time.time() - t, 1),
            "target_words": out["target_words"], "rules": rules}


def decide(table, f):
    for i, r in enumerate(table["rules"]):
        if all(f[k] in r[k] for k in FEATURES):
            return r["action"], i
    raise RuntimeError("policy table is not total")     # unreachable: compile_policy guarantees a universal last rule


def features_from_text(s):
    """Test helper: inverse of the harness's situation sentences."""
    f = {"health": re.search(r"[Hh]ealth is (\w+)", s).group(1), "attacked": "yes" if "attacking me" in s else "no",
         "healing_items": "no" if "no healing items" in s else "yes", "loot": "yes" if "Loot is on the ground" in s else "no"}
    f["enemy"] = ("none" if "No enemies" in s else "far" if "far away" in s else "medium" if "medium distance" in s else "close")
    return f


if __name__ == "__main__":
    # policy.py <dev|heldout> <runs> [model]
    cases = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "policy_cases.json")))[sys.argv[1]]
    runs = int(sys.argv[2]); model = sys.argv[3] if len(sys.argv) > 3 else None
    for run in range(runs):
        tables, ok, miss, us = {}, 0, [], []
        for c in cases:
            if c["objective"] not in tables:
                tables[c["objective"]] = compile_policy(c["objective"], model)
            t = time.perf_counter(); a, i = decide(tables[c["objective"]], features_from_text(c["situation"])); us.append(1e6 * (time.perf_counter() - t))
            if a in c["expect"]: ok += 1
            else: miss.append((c["objective"][:40], c["situation"][:70], a, f"rule {i}: {tables[c['objective']]['rules'][i]['why']}"))
        print("   target_words:", {o[:34]: t["target_words"] for o, t in tables.items()})
        print(f"run {run}: {ok}/{len(cases)} correct | {len(tables)} objectives compiled in {[t['compile_s'] for t in tables.values()]} s, "
              f"rules per table {[len(t['rules']) for t in tables.values()]} | decide max {max(us):.0f} microseconds", flush=True)
        for m in miss: print("    MISS", m)
        json.dump(list(tables.values()), open(os.path.expanduser(f"~/atlyss-harness-work/policy-tables-{sys.argv[1]}-{run}.json"), "w"), indent=1)
