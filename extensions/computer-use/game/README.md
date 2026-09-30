# Game harness (ATLYSS)

Planner compiles an objective into an ordered rule table once (Qwen3.8-27B via llama-swap);
the runtime loop looks the rule up per frame and a controller turns the behavior into keys.
No model runs inside the frame loop.

    game (Unity, Proton) <- BepInEx plugin bridge/Bridge.cs -> UDP 47801 state / 47802 commands <- agent.py

## Run

    ~/atlyss-harness-work/launch-unfocused.sh          # starts the game, waits for the main menu
    python3 agent.py --objective "..." --slot 2 --seconds 170 --out ~/atlyss-harness-work/runs/<name>
    python3 ~/atlyss-harness-work/analyze.py ~/atlyss-harness-work/runs/<name> [--timeline]

Plugin change: `dotnet build -c Release -o ~/atlyss-harness-work/build` in `bridge/`, stop the
game, copy `FastCUBridge.dll` to `<game>/BepInEx/plugins/`, relaunch.
Remove everything: Steam and game closed, `bash install.sh uninstall`.

## Commands

`K <seq> <keys,comma> [camera_yaw_deg]`, `ENTER <slot>` (single player only), `RESPAWN`.
Keys are released by the plugin if no command arrives for 0.3 s.

## Measured 2026-09-29 (3 runs x 170 s, Piko lvl 4, bow, Outer Sanctum)

| run | ticks | roundtrip ms med / p99 / max | over 50 ms | kills | deaths |
|-----|-------|------------------------------|-----------|-------|--------|
| 1   | 9288  | 16.6 / 22.0 / 51.7           | 1         | 9     | 2      |
| 2   | 9847  | 16.6 / 22.0 / 55.4           | 1         | 15    | 1      |
| 3   | 9786  | 16.6 / 22.0 / 46.1           | 0         | 13    | 1      |

roundtrip = agent sends command -> first state datagram echoing its seq (includes one 60 fps frame).
decide (rule lookup + controller) median 0.09 ms, max 0.91 ms.

## Things that cost time

- The game hangs on its loading screen when its window holds keyboard focus while loading
  (3/3 focused launches, vanilla included; unfocused launches load). Use launch-unfocused.sh.
- `settings.json` `_setGamepadType: 1` (controller mode) makes the game ignore the mouse attack
  button after the first shot. The plugin follows the game's per-frame mode apply with keyboard
  mode while commands are fresh; the file is not written and the mode returns when the agent stops.
- Attacks go along the camera yaw, so the agent commands the camera, not only movement keys.
- Other zones stay loaded additively: creeps and items are filtered to the player's scene.
- Training dummies are creeps; `hostile` (`_canAggro`) separates them from enemies.

## Not covered

- Healing path: the test character carries no healing items, rule never fired live.
- Loot pickup, dungeons, bosses, skills, dash, block: not exercised.
- Navigation is straight-line with jam detours, no pathfinding.
- The `combat.flags` reflection dump in the state is diagnostic weight; drop it if frame cost matters.
