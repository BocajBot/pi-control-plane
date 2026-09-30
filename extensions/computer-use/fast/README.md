# fast/ — accessibility-tree computer-use path

Built and validated 2026-09-29. Sibling of the vision loop in `../core.ts`;
not yet wired into it (see Gaps).

## Shape

```
goal ──> planner.py        slow LLM (nex-n25-mini:think via llama-swap), ONCE per goal,
   │                       sees the control list as text, grammar-constrained step list
   ▼
step ──> agent.py          per step, no screenshot, no pointer:
           a11y.py           AT-SPI snapshot of ONE named window            ~16 ms
           decide_server.py  GLiNER2.5-Decide picks the control (CPU)       ~220 ms
           risk_judge.py     LLM risk verdict per control NAME, cached      0 ms warm / ~1.7 s first sight
           a11y.py           semantic action (do_action / set text)         <1 ms
           a11y.py           verify by re-reading state
```

Outcomes per step: `done`, `blocked`, `escalate`, `failed`. A plan stops at the
first step that is not `done`.

## Safety layers (any doubt = no action)

1. scope: only elements of the one named app + window title are candidates
2. candidates: actionable roles only (static labels are never offered)
3. cross-check: planner's `target` and GLiNER's independent pick must agree
   (without a planner: GLiNER confidence >= 0.90)
4. word list on the chosen control's name
5. risk judge: 5 votes, majority, cached per name; unavailable = blocked
6. approval: a risky control runs only if the CALLER listed its exact name;
   the planner's schema has no approval field
7. typed text screened by a deny pattern

## Run

```
# decision server (own venv, ~18 s load); localhost only
~/computer-use-work/venv/bin/python decide_server.py 8377
# one goal
python3 planner.py <atspi-app-name> <window-title> "<goal>" '["Approved control name"]'
# validation (system python: needs python-gobject)
python3 instrument_control.py <outdir> && python3 instrument_control_e2e.py <outdir>
python3 validate.py <dev|heldout> <reps> <outdir>
python3 e2e.py <dev|heldout|heldout2|heldout3> <reps> <outdir>
python3 risk_judge.py <dev|heldout|heldout2> <reps>
```

Weights: `~/models/fastino/GLiNER2.5-Decide` (revision and sha256 in its
`SOURCE.txt`); the server runs offline. Override with `FASTCU_DECIDE_MODEL`.
Venv: `uv venv --python 3.11`, CPU torch, `gliner2[local]`;
lock in `~/computer-use-work/requirements.lock.txt`.
All run artifacts and frozen hashes: `~/computer-use-work/runs/`.

## Results (ground truth = test app event log; bars fixed before each run)

| Run | n | Correct | Disallowed control fired |
|---|---|---|---|
| single step, held-out paraphrases, no planner (`heldout-1`) | 84 trials | positives 21/33, RED (bar: <=10% refusals) | 0/48 |
| end-to-end held-out 1, any-of-3 judge | 27 | 21/27, RED | 0 |
| end-to-end held-out 2, majority-of-5 judge | 36 | 33/36 | 2 unrequested Save/Apply, RED |
| end-to-end held-out 3, no-overreach planner prompt | 39 | 38/39 | 0, GREEN |
| risk gate on unseen names (held-out 1 + 2) | 39 risky / 35 safe | 2 safe blocked | 0 risky passed |

Destructive control fired without approval: 0 in every run.
Warm step: median 277 ms (225-315). Warm goal: median 2.4 s, of which the
planner is ~1.8 s. Planner tail: one call took 19.5 s.

## Findings

- GLiNER cannot judge risk zero-shot (6 framings, all overlapping scores);
  it is used for picking only.
- The word list alone passed 19 of 39 unseen risky names; the judge is what
  catches them.
- Judge answers flip between identical calls at temperature 0; risky names
  were unanimous (9/9), noise is on the safe side only.
- GLiNER picked a static label over the button when labels were offered.
- GTK4 reports every element at (0,0); semantic actions still work.
- Free paraphrase without a planner gets refused often (confidence < 0.90 on
  correct picks). That mode is safe but not reliable.

## Gaps

- Validated on ONE GTK3 test app. No real application has been driven.
- Apps with no accessibility tree (kitty, canvas, games) need the vision loop;
  `escalate` is returned to the caller but not wired to `../core.ts`.
- Risk is judged from the control NAME only. `OK` inside a "Delete
  everything?" dialog looks safe. Dialog context is not part of the verdict.
- The gate polices dangerous controls, not unrequested ones; overreach is
  handled only by the planner prompt (2/36 before the prompt fix, 0/39 after).
- Step order inside a plan is not enforced against the goal (1/39 swapped).
- Windows are addressed by title; two windows with the same title in one app
  are not distinguished.
- Each held-out set was used once and is now spent. New changes need new sets.
