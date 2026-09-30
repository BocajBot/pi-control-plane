# computer-use (pi extension + local structured-output sidecar)

Drives the X11 desktop through a **completely local** loop: screenshot →
grammar-constrained structured action → `xdotool` → repeat. The main pi agent
pays one tool call per GUI task instead of one vision turn per GUI step.

## Files

| File | Role |
|---|---|
| `schema.json` | Action JSON schema used as llama.cpp `response_format.json_schema` (grammar-constrained decoding) |
| `core.ts` | Loop engine. No pi imports — runnable standalone. Fixed `xdotool` allowlist; model never picks a command line |
| `index.ts` | pi extension wrapper (`computer_use` tool) |
| `demo.ts` | Headless demo: spawns `xmessage` dialog, clicks OK, verifies closure, writes evidence |
| `artifacts/<stamp>/` | Per-run evidence: screenshots (png + the exact downscaled jpg sent), per-step model JSON, `trace.json`, `verdict.json`, `manifest.json` with checksums |

## Install (manual by design)

Agent config is control-plane-protected; installation is a deliberate human step:

```bash
cp -r extensions/computer-use ~/.pi/agent/extensions/
```

Development load without installing: `pi --extension ./extensions/computer-use/index.ts`

## Configuration (env)

| Var | Default | Meaning |
|---|---|---|
| `COMPUTER_USE_BASE_URL` | `http://localhost:9292/v1` | llama-swap OpenAI endpoint (matches `models.json` provider) |
| `COMPUTER_USE_MODEL` | `nex-n25-mini:nothink` | request id incl. `:nothink` thinking-off suffix (bare `reasoning_effort` body fields do NOT switch this template) |
| `DISPLAY` | `:0` | X11 display |
| `COMPUTER_USE_MAX_STEPS` | `8` | iteration cap |
| `COMPUTER_USE_ARTIFACT_DIR` | — | evidence dir (required at runtime; auditability) |
| `COMPUTER_USE_DRY_RUN` | `0` | `1` = print argv, execute nothing |

## Validation status

- `demo.ts --selftest`: argv construction, negative-case rejection, schema load,
  parse round-trip — **no GUI, no GPU**. PASS.
- Live demonstrations: 11 recorded runs — see `DEMO-HISTORY.md` for the full
  evidence table and root causes. **Harness proven end-to-end** (delivery
  verified with 0 displacements in all clean runs); **model verdict: FAIL** on
  the click tasks (nex-n25-mini `:nothink`: ±25px aim scatter, corner-aiming,
  missed a clearly visible ~100px OK button entirely; agents-a1: wrong-monitor
  aim). Vendor computer-use scores do not transfer to this local config.
- PASS criterion was never weakened: the dialog must be externally verified
  closed. All FAILs are recorded as measured.

## Known gaps / required before production

- **Destructive-action gate.** nex-n25-mini is recorded `delete_database 3/3`
  and injection-prone. The type-payload regex guard in `core.ts` is minimal;
  a real gate (confirm-on-dangerous, no typing into shells) is required before
  leaving demos.
- **Schema gap:** `required: [action, thought]` only — the grammar legally
  allows `click` without x/y (observed from both models). Runtime validator
  rejects and the loop feeds back for retry (resilience fix); a per-action
  (oneOf) schema would prevent it at the grammar level.
- **Model reliability:** do not deploy unattended until the model's grounding
  is re-validated on YOUR tasks (see DEMO-HISTORY findings).
- **X11 only.** `xdotool`/`import` — no Wayland path (`ydotool`/`wtype` not installed).
- **Input isolation (MPX)** is default-on and reversible; `jiti demo.ts
  --restore-input` recovers from partial setup. The agent drives a second
  master cursor (`CU-Agent`); physical and Deskflow (`libvirtualhid *`)
  devices stay on the core masters, so the user's cursor never moves.
  `xdotool` is steered by the `cu-client-pointer.so` preload shim (build
  command in `cu-client-pointer.c`; rebuild after an X11/libXi upgrade).
- `captureToDataUrl` (artifact-less mode) intentionally unimplemented.

## Game harness

Moved to the private repo `BocajBot/atlyss-fastcu-bridge` (was `game/`).
