#!/usr/bin/env python3
"""ATLYSS agent: state (UDP, from the bridge plugin) -> decision -> virtual keys.

Layers, slowest to fastest:
  planner    Qwen3.8, once per objective    objective -> ordered rule table      (seconds)
  matcher    word match, per new name set   which creature names the orders name (microseconds)
  policy     rule-table lookup, every tick  state features -> behavior           (microseconds)
  controller pure code, every tick          behavior -> held keys                (microseconds)

Safety:
  - only keys in ALLOWED are ever sent (no chat, console, escape, menus)
  - no keys while in a menu, in UI, loading, or dead
  - the plugin releases every key if this process stops sending for 0.3 s
  - hard wall-clock limit per run

Usage: agent.py --objective "..." [--seconds 60] [--slot 2] [--dry-run]
"""
import argparse, hashlib, json, math, os, random, re, socket, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import policy

STATE_ADDR, CMD_ADDR = ("127.0.0.1", 47801), ("127.0.0.1", 47802)
ATTACK_RANGE, LOOT_RANGE = 2.6, 1.6
ATTACK_PERIOD, ATTACK_HOLD = 0.30, 0.20   # seconds; press/release cycle for the attack button
RANGED, RANGED_RANGE, RANGED_MIN = {"Bow", "Scepter", "Magic Bell"}, 9.0, 5.0   # weapon types that shoot
BLOCKED_RANGE = 7.0                      # stalled this close to a target = touching it, attack from here
PORTAL_RANGE, PORTAL_AFTER = 2.0, 5.0   # walk to a portal after this many seconds with no creep in the zone
CLOSE, MEDIUM, FAR = 7.0, 16.0, 45.0


def features(st, targets):
    p = st["player"]
    frac = p["hp"] / max(1, p["max_hp"])
    near = min(targets, key=lambda c: c["dist"], default=None)
    d = near["dist"] if near else 1e9
    return {"health": "low" if frac < 0.35 else "medium" if frac < 0.7 else "high",
            "enemy": "close" if d < CLOSE else "medium" if d < MEDIUM else "far" if d < FAR else "none",
            "attacked": "yes" if any(c["aggro_on_me"] for c in st["creeps"]) else "no",
            "healing_items": "yes" if st.get("heal_slots") else "no",
            "loot": "yes" if any(i["dist"] < 25 for i in st.get("items", [])) else "no"}, near


class TargetFilter:
    """Which creatures count as enemies to engage. The planner names the
    creature words the orders single out (policy["target_words"]); a creature
    matches when one of its name words equals a target word, plural-insensitive
    ("slime" matches "Blue Slime", not "Mekboar" for "boar"). Empty list =
    orders speak of enemies in general = every creature counts.

    Deliberately not a model at runtime: GLiNER multi-label was tried for this
    (2026-09-29) and returned one name where two matched, and picked "Boar"
    for orders that named no creature.
    """
    def __init__(self, target_words):
        self.words = {self.stem(w) for w in target_words}

    @staticmethod
    def stem(w):
        w = w.lower()
        return w[:-1] if len(w) > 3 and w.endswith("s") else w

    def allowed(self, names):
        if not self.words:
            return set(names)
        return {n for n in names if any(self.stem(t) in self.words for t in re.findall(r"[A-Za-z]+", n))}


class Controller:
    def __init__(self, keys):
        self.k = keys
        self.heading = random.uniform(0, 360)
        self.last_pos, self.last_move_t, self.heal_t, self.jump_until = None, time.time(), 0.0, 0.0
        self.creep_seen_t, self.detour_until, self.map, self.visited = time.time(), 0.0, None, set()
        self.want, self.detour_yaw, self.detour_n = 0.0, 0.0, 0
        self.cam = None                                        # camera yaw to command this tick (attacks aim along it)

    def move_keys(self, world_yaw, cam_yaw):
        """8-way keys whose camera-relative direction is closest to world_yaw."""
        rel = (world_yaw - cam_yaw) % 360
        s = int(((rel + 22.5) % 360) // 45)
        fwd, right = [1, 1, 0, -1, -1, -1, 0, 1][s], [0, 1, 1, 1, 0, -1, -1, -1][s]
        out = []
        if fwd: out.append(self.k["up"] if fwd > 0 else self.k["down"])
        if right: out.append(self.k["right"] if right > 0 else self.k["left"])
        return out

    @staticmethod
    def yaw_to(a, b):
        return math.degrees(math.atan2(b[0] - a[0], b[2] - a[2])) % 360

    def keys_for(self, behavior, st, near):
        p, now = st["player"], time.time()
        pos, cam = p["pos"], p["cam_yaw"] if p["cam_yaw"] is not None else p["yaw"]
        moved = self.last_pos is None or math.dist(pos, self.last_pos) > 0.15
        if moved:
            self.last_pos, self.last_move_t = pos, now
        keys, want_move, self.cam = [], False, None
        stalled = now - self.last_move_t > 0.4
        def go(yaw):                                           # turn the camera to yaw and walk forward
            self.want = yaw
            self.cam = self.detour_yaw if now < self.detour_until else yaw
            return [self.k["up"]]
        if behavior == "attack the nearest enemy" and near:
            aim = self.yaw_to(pos, near["pos"])
            ranged = (st.get("combat") or {}).get("weapon_type") in RANGED
            reach = RANGED_RANGE if ranged else ATTACK_RANGE
            blocked = stalled and near["dist"] < BLOCKED_RANGE  # large bodies stop us outside ATTACK_RANGE
            if near["dist"] > reach and not blocked:
                keys += go(aim); want_move = True
            else:
                self.cam = aim                                 # shots and swings go along the camera yaw
                if ranged and near["dist"] < RANGED_MIN:       # crowded: back-pedal while still facing the target
                    keys.append(self.k["down"])
            if (near["dist"] < reach * 1.6 or blocked) and now % ATTACK_PERIOD < ATTACK_HOLD:
                keys.append(self.k["attack"])                  # pulsed: a held button stops swinging after the first combo
        elif behavior == "retreat away from enemies":
            threat = min((c for c in st["creeps"] if c["aggro_on_me"]), key=lambda c: c["dist"], default=near)
            if threat and threat["dist"] < FAR:                 # out of reach already: stop and hold position
                keys += go((self.yaw_to(pos, threat["pos"]) + 180) % 360); want_move = True
        elif behavior == "use a healing item" and st.get("heal_slots"):
            if now - self.heal_t > 2.0:
                self.heal_t = now
            if now - self.heal_t < 0.12:                       # hold the key ~4 ticks, then cooldown
                keys.append(self.k["consumables"][st["heal_slots"][0]["slot"]])
        elif behavior == "pick up the loot" and st.get("items"):
            it = min(st["items"], key=lambda i: i["dist"])
            if it["dist"] > LOOT_RANGE:
                keys += go(self.yaw_to(pos, it["pos"])); want_move = True
            elif int(now * 4) % 2 == 0:
                keys.append(self.k["interact"])
        elif behavior == "explore to find enemies":
            far = min((c for c in st["creeps"] if c["targetable"] and c.get("hostile", True)), key=lambda c: c["dist"], default=None)
            if p["map"] != self.map:                           # new zone: give it time before leaving again
                self.map, self.creep_seen_t = p["map"], now
                self.visited.add(p["map"])
            ports = [q for q in st.get("portals", []) if q["type"] == "NORMAL"]
            ports = [q for q in ports if q["to"] not in self.visited] or ports   # prefer zones not yet searched
            portal = min(ports, key=lambda q: q["dist"], default=None)
            if far:
                self.creep_seen_t = now
                self.heading = self.yaw_to(pos, far["pos"])
            elif portal and now - self.creep_seen_t > PORTAL_AFTER and now > self.detour_until:
                self.heading = self.yaw_to(pos, portal["pos"])
                if portal["dist"] < PORTAL_RANGE:
                    return [self.k["interact"]] if int(now * 4) % 2 == 0 else []
            keys += go(self.heading); want_move = True
        if want_move and now - self.last_move_t > 1.0 and not (near and near["dist"] < BLOCKED_RANGE):         # stuck: hop, then pick another heading
            self.jump_until, self.last_move_t = now + 0.2, now
            self.heading = (self.heading + random.uniform(60, 300)) % 360
            self.detour_n = self.detour_n + 1 if now - self.detour_until < 3.0 else 1   # repeated jams: swing wider, go longer
            self.detour_yaw = (self.want + random.choice((-1, 1)) * min(150, 50 + 30 * self.detour_n)) % 360
            self.detour_until = now + min(4.0, 1.0 + 0.5 * self.detour_n)
        if now < self.jump_until:
            keys.append(self.k["jump"])
        return keys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--objective", required=True)
    ap.add_argument("--seconds", type=float, default=60)
    ap.add_argument("--slot", type=int, default=None, help="enter single player with this save slot if at the main menu")
    ap.add_argument("--dry-run", action="store_true", help="decide and log, send no keys")
    ap.add_argument("--out", default=os.path.expanduser(f"~/atlyss-harness-work/runs/{time.strftime('%Y%m%dT%H%M%S')}"))
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    h = hashlib.sha256(a.objective.encode()).hexdigest()[:16]
    tp = os.path.expanduser(f"~/atlyss-harness-work/policies/{h}.json")
    if os.path.exists(tp):
        table = json.load(open(tp))
    else:
        print(f"[agent] compiling policy with {policy.PLANNER} ...", flush=True)
        table = policy.compile_policy(a.objective)
        os.makedirs(os.path.dirname(tp), exist_ok=True); json.dump(table, open(tp, "w"), indent=1)
    json.dump(table, open(os.path.join(a.out, "policy.json"), "w"), indent=1)
    for i, r in enumerate(table["rules"]):
        print(f"[agent] rule {i}: {r['action']:28s} | {r['why']}", flush=True)

    rx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); rx.bind(STATE_ADDR); rx.settimeout(1.0)
    tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    tf, ctl, log = TargetFilter(table.get("target_words", [])), None, open(os.path.join(a.out, "ticks.jsonl"), "w")
    print(f"[agent] target words: {table.get('target_words') or 'any enemy'}", flush=True)
    seq, sent_at, t_end, entered, n_state = 0, {}, time.time() + a.seconds, 0.0, 0
    ALLOWED = set()
    try:
        while time.time() < t_end:
            try:
                raw = rx.recv(65535)
            except socket.timeout:
                print("[agent] no state from game (is it running with the plugin?)", flush=True); continue
            t0 = time.perf_counter(); st = json.loads(raw); n_state += 1
            rt = None
            if st["seq"] in sent_at:                           # first state that echoes our command
                rt = 1000 * (time.time() - sent_at.pop(st["seq"]))
                for k in [k for k in sent_at if k < st["seq"]]: sent_at.pop(k)
            rec = {"t": time.time(), "frame": st["frame"], "game_dt_ms": round(1000 * st["dt"], 1), "roundtrip_ms": rt,
                   "watchdog": st["watchdog"], "error": st["error"]}
            p = st.get("player")
            if not p:
                if st.get("in_menu") and a.slot is not None and time.time() - entered > 15:
                    entered = time.time(); tx.sendto(f"ENTER {a.slot}".encode(), CMD_ADDR)
                    print(f"[agent] at main menu: entering single player, slot {a.slot}", flush=True)
                rec["skip"] = "no player"; log.write(json.dumps(rec) + "\n"); continue
            if ctl is None:
                k = st["keys"]; ctl = Controller(k)
                ALLOWED = {k["up"], k["down"], k["left"], k["right"], k["attack"], k["jump"], k["interact"], *k["consumables"]}
            keys, behavior, f, rule, near = [], None, None, None, None
            if p["condition"] == "DEAD":
                if int(time.time()) % 5 == 0: tx.sendto(b"RESPAWN", CMD_ADDR)
                rec["skip"] = "dead"
            elif p["condition"] != "ACTIVE" or p["game"] != "IN_GAME" or p["in_ui"]:
                rec["skip"] = f"not controllable ({p['condition']}, {p['game']}, in_ui={p['in_ui']})"
            else:
                live = [c for c in st["creeps"] if c["targetable"] and c["hp"] > 0 and c.get("hostile", True)]
                names = tf.allowed({c["name"] for c in live})
                f, near = features(st, [c for c in live if c["name"] in names])
                behavior, rule = policy.decide(table, f)
                keys = [k for k in ctl.keys_for(behavior, st, near) if k in ALLOWED]
            decide_ms = 1000 * (time.perf_counter() - t0)
            seq += 1
            if not a.dry_run:
                yaw = "" if ctl is None or ctl.cam is None or not keys else f" {ctl.cam:.1f}"
                tx.sendto(f"K {seq} {','.join(sorted(set(keys)))}{yaw}".encode(), CMD_ADDR); sent_at[seq] = time.time()
            rec.update({"seq": seq, "decide_ms": round(decide_ms, 3), "features": f, "rule": rule, "behavior": behavior, "keys": sorted(set(keys)), "cam": ctl.cam if ctl else None, "cam_yaw": p["cam_yaw"], "portals": len(st.get("portals", [])), "action": p["action"], "combat": st.get("combat"), "near_pos": near["pos"] if near else None,
                        "hp": p["hp"], "max_hp": p["max_hp"], "pos": p["pos"], "map": p["map"], "level": p["level"],
                        "creeps": [(c["name"], round(c["dist"], 1), c["hp"], c["aggro_on_me"]) for c in sorted(st["creeps"], key=lambda c: c["dist"])[:5]],
                        "items": len(st.get("items", [])), "focused": st["focused"]})
            log.write(json.dumps(rec) + "\n")
            if n_state % 60 == 0:
                print(f"[agent] hp {p['hp']}/{p['max_hp']} {f} -> {behavior} keys={sorted(set(keys))} decide={decide_ms:.2f}ms roundtrip={rt}", flush=True)
    finally:
        tx.sendto(f"K {seq + 1} ".encode(), CMD_ADDR)           # release everything
        log.close()
        print(f"[agent] stopped; log {a.out}/ticks.jsonl", flush=True)


if __name__ == "__main__":
    main()
