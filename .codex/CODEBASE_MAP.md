# Codebase Map

## Metadata
- Repository: `pi-control-plane`
- Root: `/home/bocaj/Documents/pi-control-plane`
- Purpose: Pi extension package for execution policy, context controls, model selection, diagnostics, credits, and task tracking.
- Branch: `master`
- Mapped commit: `619ae512e1fe575f3865fe71004112697b333ade`
- Working tree: Modified by active control-plane work; preserve all existing changes.
- Last updated: 2026-09-17
- Status: partial, task-focused
- Task focus: persistent task tool with wrapped widget rows, model-price picker rows, and Pi-package read carve-out
- Excluded or unexplored areas: transcription internals, RPC smoke implementation, skill internals

## Technology Stack
- TypeScript executed by Node.js 22 native type stripping
- Pi extension API from `@earendil-works/pi-coding-agent`
- Node built-in test runner

## Top-Level Structure
| Path | Responsibility | Notes |
|------|----------------|-------|
| `extensions/` | Pi extension entry points | `control-plane.ts` owns task registration and TUI wiring |
| `AGENTS.md` | Repository-specific agent continuity | Preservation rules and documentation protocol; README carries feature inventory |
| `src/control-plane/` | Domain and rendering modules | `todo.ts` owns task state transitions and rendering |
| `tests/` | Unit and extension integration tests | `extension-harness.test.ts` exercises fake Pi lifecycle |
| `policy/` | Tool profiles and default policy | Security-sensitive enforcement inputs |
| `docs/` | Architecture, TUI, testing, security | Commands and expected test counts documented here |

## Entry Points
| Entry Point | Path | Execution Flow |
|-------------|------|----------------|
| Control plane | `extensions/control-plane.ts` | Pi loader -> register tools/events/UI -> state restoration -> policy enforcement |
| Model picker | `extensions/model-picker.ts` | Startup or `/models` -> model filtering and selection |

## Major Components

### Task tracking
- Responsibility: Model-callable task CRUD, session persistence, prompt injection, pinned rendering.
- Primary paths: `src/control-plane/todo.ts`, `extensions/control-plane.ts`
- Public interfaces: `todo` tool; `pi-control-plane-todo` session entries
- Dependencies: Pi `appendEntry`, `getBranch`, `setWidget`, `showOverlay`, `requestRender`; atomic workspace state under Pi agent state
- Tests: `tests/todo.test.ts`, `tests/extension-harness.test.ts`
- Risks and invariants: IDs remain stable; malformed entries ignored; branch state follows active branch; completing a task removes it from persistent live state and writes a transcript completion entry; widget never exceeds terminal width; task text wraps without dropping words; cyberpunk theme supplies Todo-specific neon-purple tokens with safe stock-theme fallbacks.

### Policy and modes
- Responsibility: Active tools, phase/autonomy gates, confirmations, persistence.
- Primary paths: `src/control-plane/tool-policy.ts`, `src/control-plane/state.ts`, `policy/`
- Risks and invariants: Tool registration must not bypass policy or approval gates; Pi-owned package reads are allowed only below agent dir while `auth.json` and all mutations remain blocked.

### Model picker
- Responsibility: Filter and select registry models with paging and price badges.
- Primary paths: `extensions/model-picker.ts`, `src/control-plane/model-picker.ts`
- Tests: `tests/model-picker.test.ts`

### TUI and observability
- Responsibility: Header, footer, diagnostics, credits, timing, task widget.
- Primary paths: `extensions/control-plane.ts`, `src/control-plane/ui.ts`, `src/control-plane/credits.ts`, `src/control-plane/turn-timing.ts`

## Important Data Flows

### Task lifecycle
1. Model calls registered `todo` tool.
2. Tool validates operation and mutates immutable task state.
3. Extension appends `pi-control-plane-todo` entry and atomically saves workspace state.
4. Overlay requests immediate TUI render.
5. Session reload or branch switch selects newest valid session/workspace state.
6. Noncapturing overlay renders at top-right.

Relevant symbols:
- `extensions/control-plane.ts`: `installTodoWidget`, `refreshTodoWidget`, `registerTool({ name: "todo" })`
- `src/control-plane/todo.ts`: task mutations, restoration, prompt and widget rendering

## Cross-Cutting Systems
- Configuration: `policy/*.json`, Pi user settings outside repository
- Persistence: append-only Pi session custom entries plus atomic workspace task JSON under Pi agent state
- Error handling: malformed persisted state ignored; invalid task operations return structured errors
- Security: tool calls pass through central policy handler

## Test Architecture
| Type | Location | Command | Notes |
|------|----------|---------|-------|
| Full unit/integration | `tests/*.test.ts` | `npm test` | Node built-in runner |
| Task-focused | `tests/todo.test.ts`, `tests/extension-harness.test.ts` | `node --test tests/todo.test.ts tests/extension-harness.test.ts` | Includes reload and branch restoration |
| Live RPC | `tests/smoke/rpc-smoke.mjs` | See `docs/TESTING.md` | Requires local model service |

## Build and Validation
| Purpose | Command | Source of Truth |
|---------|---------|-----------------|
| Full tests | `npm test` | `package.json` |
| Diff whitespace | `git diff --check` | Working agreement |

## Change Impact Guide
| Change Type | Likely Areas | Required Validation |
|-------------|--------------|---------------------|
| Task behavior | task module, extension entry, TUI docs | focused tests, full tests, Pi loader smoke |
| Tool policy | policy module and profiles | policy and extension harness tests |
| Model picker rows/navigation | model-picker pure logic and extension | model-picker tests, live TUI capture |
| Footer credits | credits module and extension lifecycle | credits and extension harness tests |

## Sensitive or Restricted Areas
- `policy/` controls execution authorization.
- OpenRouter credentials remain external; tests use fabricated values.
- User Pi settings and session files are runtime state outside repository.

## Generated or Vendored Content
- `node_modules/` when present is third-party and excluded.
- `pnpm-lock.yaml` is currently untracked and not part of this task.

## Evidence-Supported Technical Debt
- Pi's underlying TUI exposes public noncapturing overlays; task widget uses `showOverlay` with `top-right` anchor and widget-owned cleanup.

## Unresolved Questions
- None for current task.

## Recent Updates
| Commit or Working Change | Affected Sections | Update |
|--------------------------|-------------------|--------|
| Working tree | Task tracking, TUI, tests | Added task tool persistence, pinned widget, immediate repaint, reload and branch restoration coverage. |
| Working tree | Task tracking, TUI, tests | Completing a task now removes it from live state and appends its completion sentence to the transcript. |
| Working tree | Model picker and policy | Restored OpenRouter input/output price labels and permitted Pi package documentation reads without exposing credentials. |
| Working tree | Native Pi model selector | Scoped OpenRouter models now restore cached catalog pricing; runtime-bundle regression test guards installed `/model`. |
| Working tree | Agent continuity | Added root AGENTS.md directing future sessions to preservation rules and required documentation updates. |
