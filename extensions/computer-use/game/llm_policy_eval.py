#!/usr/bin/env python3
"""Small-LLM policy eval through llama-swap: grammar-constrained behavior
choice, thinking off. Reports accuracy and wall latency per call.
Usage: llm_policy_eval.py <dev|heldout> <passes> <model> [<model>...]"""
import json, os, statistics, sys, time, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__))
D = json.load(open(os.path.join(HERE, "policy_cases.json")))
B = D["behaviors"]
SYSTEM = ("You control a character in a game. Follow the orders exactly. "
          "Given the current situation, choose the ONE action that the orders require right now. "
          "Actions: " + "; ".join(B) + ".")
SCHEMA = {"type": "object", "additionalProperties": False, "required": ["action"], "properties": {"action": {"type": "string", "enum": B}}}
def ask(model, o, s):
    body = {"model": model, "temperature": 0, "max_tokens": 24, "cache_prompt": True,
            "chat_template_kwargs": {"enable_thinking": False},
            "messages": [{"role": "system", "content": SYSTEM + " Orders: " + o}, {"role": "user", "content": s}],
            "response_format": {"type": "json_schema", "json_schema": {"name": "a", "schema": SCHEMA, "strict": True}}}
    t = time.perf_counter()
    req = urllib.request.Request("http://localhost:9292/v1/chat/completions", json.dumps(body).encode(), {"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r: d = json.load(r)
    ms = 1000 * (time.perf_counter() - t)
    return json.loads(d["choices"][0]["message"]["content"])["action"], ms, d.get("timings", {}), d.get("usage", {})
split, passes = sys.argv[1], int(sys.argv[2])
for model in sys.argv[3:]:
    try:
        ask(model, "Do nothing.", "Nothing is happening.")            # load + warm, not measured
        ok, ms, miss, tm = 0, [], [], None
        for p in range(passes):
            for c in D[split]:
                a, m, tm, us = ask(model, c["objective"], c["situation"]); ms.append(m)
                if p == 0:
                    if a in c["expect"]: ok += 1
                    else: miss.append((c["objective"][:30], c["situation"][:60], a))
        ms.sort()
        print(f"{model}: {ok}/{len(D[split])} correct | wall ms min {ms[0]:.0f} median {statistics.median(ms):.0f} p95 {ms[int(.95*len(ms))-1]:.0f} max {ms[-1]:.0f} | prompt_tokens {us.get('prompt_tokens')} prompt_ms {tm.get('prompt_ms')} predicted_ms {tm.get('predicted_ms')} n_pred {tm.get('predicted_n')}", flush=True)
        for m in miss: print("     MISS", m)
    except Exception as ex:
        print(f"{model}: ERROR {repr(ex)[:200]}", flush=True)
