# Demonstration history — computer-use extension (2026-09-29)

All runs: X11 `:0` (i3, 3840x1080 dual-head root), llama-swap @ 127.0.0.1:9292,
PASS criterion unchanged throughout: **the dialog must actually be closed,
verified externally via `xdotool search` — never the model's word.**

| # | artifacts/ | model / config | verdict | Root cause (evidence state) |
|---|---|---|---|---|
| 1 | 2026-09-29T17-55-54 | nex `:nothink` 1280w | FAIL (1 step) | Task stimulus defect: task named the WM title 'CU-Demo', invisible in screenshots (i3 has no title bars). Model: "dialog is already gone". Perception probe proved the dialog WAS visible. Fixed: task references visible text. |
| 2 | 2026-09-29T17-59-08 | nex `:nothink` 1280w | FAIL (2 steps) | Harness bug: `xdotool getdisplaygeometry` reported 1920 while root capture is 3840 wide → click x scaled by half, landed on the wrong monitor half. Fixed: scale against `xwininfo -root`. |
| 3 | 2026-09-29T18-01-52 | nex `:nothink` 1280w | FAIL (2 steps) | Model aim 42px above the 28x24px button (aimed (972,990) vs box (972-1000,1032-1056)). Delivery unverifiable at the time (see confound below). |
| 4 | 2026-09-29T18-03-08 | nex `:nothink` 2560w | FAIL (5 steps) | Aim (976,1030), ~2px outside button box, repeated identically 5x. **Confound discovered**: user was moving the mouse; physical input interleaves with XTEST on the shared core pointer, so misses were not attributable. |
| 5 | 2026-09-29T18-04-47 | agents-a1 2560w | FAIL (0 steps) | 300-token budget consumed by reasoning; empty content (`finish_reason: length`). Budget too small for reasoning models. |
| 6 | 2026-09-29T18-05-25 | agents-a1 2560w, 1024 tok | FAIL (2 steps) | Aimed (2921,1026) — wrong monitor entirely. One malformed action (click w/o x). |
| 7 | (aborted at setup) | nex 2560w + MPX isolation | — | `XI_BadDevice` on libvirtualhid Pen Tablet reattach aborted setup and skipped restore; input topology left half-switched, recovered via `--restore-input`. Fixed: per-device best-effort + idempotent restore in `finally`. |
| 8 | 2026-09-29T18-19-53 | nex `:nothink` 2560w + isolation | FAIL (8 steps) | **Clean attribution** (probe: 0 displaced, delivered==aimed 8/8). Dialog tiled to x=2888 by i3; button box (2892-2920,1032-1056). Aim (2921,1056): **1px miss**, corner-aiming, repeated. |
| 9 | 2026-09-29T18-25-42 | nex `:nothink` **3840w (1:1)** + isolation | FAIL (3 steps) | Clean. Aim (2867,1046) 25px left of button box, repeated 3x. Step 4: malformed `click` w/o x aborted loop (pre-fix). |
| 10 | 2026-09-29T18-30-31 | zenity Demo-2 target (100px OK), 2560w | FAIL (0 steps) | Malformed first action (click w/o x) aborted loop (pre-fix). |
| 11 | 2026-09-29T18-31-40 | zenity Demo-2 + retry resilience | FAIL (6+2 steps) | Clean. Dialog CLEARLY VISIBLE (screenshot: white dialog + big OK at ~(900-1020, 633-658)); model aimed (1921,543), (2356,454)x3, (2302,420), (1464,403) — into the browser, 600-1600px away. Retry absorbed 2 malformed actions. |

## Confound timeline (input interference)

- User reported moving the mouse during runs 3-4. Physical/logical input shares
  the core X pointer with XTEST; interleaving displaces synthetic clicks.
  The user's input arrives via **Deskflow** (`libvirtualhid *` virtual HID
  devices), which were core-pointer slaves — same displacement mechanism.
  Runs 3-4 attribution: UNKNOWN (retract "model couldn't hit" as unproven).
- Fix chain: (a) displacement probe (`getmouselocation` inside the same xdotool
  invocation as the press; `displaced` flag per step), (b) **MPX isolation**
  (`input-isolation.ts`): physical slaves → `CU-Human` master; core retains
  XTEST only = agent cursor. User input physically cannot displace agent clicks.
- Runs 8-11: `displaced_clicks=0`, delivered==aimed every time. Failures in
  these runs are attributable to the model alone.

## Model findings (VERIFIED on runs 8-11, clean attribution)

- nex-n25-mini `:nothink`: click grounding on a 28x24px target is ±25px and
  inconsistent (1px miss run 8; 25px miss run 9) with corner-aiming and no
  retry adaptation. On a clearly visible ~100px zenity OK button it clicked
  the wrong window entirely. Vendor OSWorld 82.2 does not transfer to this
  local configuration.
- agents-a1: wrong-monitor aim; reasoning eats small token budgets.
- Malformed actions (click without x/y) from both models: schema gap —
  `required: [action, thought]` only; runtime validator catches it and (since
  the resilience fix) feeds it back for retry.

## Harness state after this session

Proven working end-to-end: capture → grammar-constrained action parse →
edge-correct coordinate mapping (root-span scaling) → verified delivery
(probe) → external outcome verification → evidence trail with checksums.
Known gaps listed in README.md.
