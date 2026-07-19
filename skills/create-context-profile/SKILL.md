---
name: create-context-profile
description: Create or edit a Pi Control Plane tool profile (a named tool loadout applied with /context profile <name>) when the user wants to reduce context size, group tools for a workflow, or asks to "make a profile" for certain tools.
---

# Create a context profile

Tool profiles are named tool loadouts for the Pi Control Plane. Applying one with `/context profile <name>` enables exactly the listed tools and toggles every other tool off, shrinking what gets sent to the model. Profiles live in `policy/profiles.json` inside the pi-control-plane package.

## Steps

1. **Locate the profiles file.** Run `pi list` and find the pi-control-plane package path (usually `~/Documents/pi-control-plane`). The file is `<package>/policy/profiles.json`.

2. **See which tools exist right now.** Ask the user to run `/context sources` (tools appear as `tool:<name>` entries), or list currently active tools from `/context`. A profile may also name tools that are not loaded in this session — they are skipped with a note when applied, so cross-project profiles are fine.

3. **Ask what the profile is for** if it is not obvious: which workflow, which tools must stay, a short name. Prefer small profiles — the point is reducing context.

4. **Edit `policy/profiles.json`.** Add or update an entry under `profiles`. Exact schema — anything else fails validation and disables ALL profiles until fixed:

```json
{
  "schemaVersion": 1,
  "profiles": {
    "research": {
      "description": "Web research: search + fetch + read, no file mutation",
      "tools": ["read", "grep", "web_search", "fetch_content"]
    }
  }
}
```

Rules:
- `schemaVersion` must be `1`.
- Each profile has exactly `description` (string) and `tools` (array of non-empty strings). No other keys.
- The name `all` is reserved (built-in profile that re-enables every tool).
- Note: this edit may require the Execute phase and an autonomy level that permits writes outside the current project root (Attended will ask for confirmation).

5. **Validate before declaring done.** Run:

```bash
node -e "JSON.parse(require('fs').readFileSync('<package>/policy/profiles.json','utf8')); console.log('valid JSON')"
```

6. **Reload and apply.** Tell the user to run `/reload`, then `/context profile <name>`. `/context profile` (no argument) lists all profiles and marks the active one. `/context profile all` undoes any profile.

## Notes

- Profiles only manage tools. Context files and skills are toggled individually with `/context toggle file:<path>` / `skill:<name>`.
- The applied profile persists with the session (survives resume) because it is stored as ordinary control-plane tool toggles.
- Check the effect with `/context` before/after: the active-tools list and payload size shrink.
