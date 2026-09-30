// FastCU Bridge: exports ATLYSS game state as JSON over UDP and lets an
// external agent hold virtual keys. Single-player automation harness.
//
//   state  -> udp 127.0.0.1:47801   one JSON datagram per tick (30 Hz)
//   input  <- udp 127.0.0.1:47802   text lines:
//       K <seq> <key>,<key>,...     full set of keys held from now on (empty = none)
//       ENTER <slot>                from the main menu: start single player with save slot
//       RESPAWN                     release soul after death
//
// Virtual keys are OR-ed into UnityEngine.Input.GetKey/GetKeyDown/GetKeyUp, so
// the game's own input code runs unchanged and real keyboard input still works.
// Safety: if no K line arrives for WATCHDOG seconds every virtual key is
// released, so a crashed agent cannot leave the character running.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Text;
using BepInEx;
using HarmonyLib;
using UnityEngine;

namespace FastCU
{
    [BepInPlugin("fastcu.bridge", "FastCU Bridge", "0.1.0")]
    public class BridgePlugin : BaseUnityPlugin
    {
        private void Awake()
        {
            Application.runInBackground = true;   // keep simulating while the window is unfocused
            new Harmony("fastcu.bridge").PatchAll();
            var go = new GameObject("FastCUBridge") { hideFlags = HideFlags.HideAndDontSave };
            DontDestroyOnLoad(go);
            go.AddComponent<BridgeRunner>();
            Logger.LogInfo("FastCU Bridge loaded: state udp 47801, input udp 47802");
        }
    }

    public static class VKeys
    {
        public static readonly HashSet<KeyCode> Held = new HashSet<KeyCode>();
        public static bool Driving;        // agent commands are fresh (inside the watchdog window)
        public static readonly Dictionary<KeyCode, int> DownFrame = new Dictionary<KeyCode, int>();
        public static readonly Dictionary<KeyCode, int> UpFrame = new Dictionary<KeyCode, int>();

        public static void Set(HashSet<KeyCode> next)
        {
            int f = Time.frameCount;
            foreach (var k in next) if (!Held.Contains(k)) DownFrame[k] = f;
            foreach (var k in Held) if (!next.Contains(k)) UpFrame[k] = f;
            Held.Clear();
            foreach (var k in next) Held.Add(k);
        }

        public static bool Down(KeyCode k) { return DownFrame.TryGetValue(k, out int f) && f == Time.frameCount; }
        public static bool Up(KeyCode k) { return UpFrame.TryGetValue(k, out int f) && f == Time.frameCount; }
    }

    // Controller mode ignores the mouse attack button, and the game re-applies the mode from its
    // settings UI every frame. While the agent drives, follow that with keyboard mode. Nothing is
    // saved: the frame the agent stops, the game's own per-frame apply puts the user's mode back.
    [HarmonyPatch(typeof(SettingsManager), nameof(SettingsManager.Handle_InputParameters))]
    static class PadModePatch
    {
        static void Postfix()
        {
            if (VKeys.Driving && InputControlManager.current != null) InputControlManager.current._setGamepadType = GamepadType.Keyboard;
        }
    }

    [HarmonyPatch(typeof(Input), nameof(Input.GetKey), new[] { typeof(KeyCode) })]
    static class P_GetKey { static void Postfix(KeyCode key, ref bool __result) { if (!__result && VKeys.Held.Contains(key)) __result = true; } }

    [HarmonyPatch(typeof(Input), nameof(Input.GetKeyDown), new[] { typeof(KeyCode) })]
    static class P_GetKeyDown { static void Postfix(KeyCode key, ref bool __result) { if (!__result && VKeys.Down(key)) __result = true; } }

    [HarmonyPatch(typeof(Input), nameof(Input.GetKeyUp), new[] { typeof(KeyCode) })]
    static class P_GetKeyUp { static void Postfix(KeyCode key, ref bool __result) { if (!__result && VKeys.Up(key)) __result = true; } }

    [HarmonyPatch(typeof(Input), nameof(Input.GetMouseButton), new[] { typeof(int) })]
    static class P_GetMouse { static void Postfix(int button, ref bool __result) { if (!__result && VKeys.Held.Contains(KeyCode.Mouse0 + button)) __result = true; } }

    [HarmonyPatch(typeof(Input), nameof(Input.GetMouseButtonDown), new[] { typeof(int) })]
    static class P_GetMouseDown { static void Postfix(int button, ref bool __result) { if (!__result && VKeys.Down(KeyCode.Mouse0 + button)) __result = true; } }

    [DefaultExecutionOrder(-32000)]   // before every game script, so a key set this frame is seen this frame
    public class BridgeRunner : MonoBehaviour
    {
        const float WATCHDOG = 0.3f;
        const float TICK = 0f;             // state every frame: command echo latency is bounded by one frame
        const float RADIUS = 60f;
        const float CREEP_RADIUS = 400f;   // far creeps give explore a heading; agent thresholds decide engagement

        UdpClient _rx, _tx;
        IPEndPoint _dst = new IPEndPoint(IPAddress.Loopback, 47801);
        float _lastCmd = -999f, _nextTick, _nextScan;
        float _camYaw = float.NaN;         // commanded camera yaw (degrees); NaN = leave camera alone
        long _seq = -1;
        int _seqFrame;
        bool _watchdogFired;
        Creep[] _creeps = new Creep[0];
        ItemObject[] _items = new ItemObject[0];
        Portal[] _portals = new Portal[0];
        readonly StringBuilder _sb = new StringBuilder(4096);
        string _lastError = "";

        void Start()
        {
            _rx = new UdpClient(new IPEndPoint(IPAddress.Loopback, 47802));
            _rx.Client.Blocking = false;
            _tx = new UdpClient();
        }

        void OnDestroy() { try { _rx?.Close(); _tx?.Close(); } catch { } }

        void Update()
        {
            try { Receive(); } catch (Exception e) { _lastError = "rx: " + e.Message; }
            if (VKeys.Held.Count > 0 && Time.unscaledTime - _lastCmd > WATCHDOG)
            {
                VKeys.Set(new HashSet<KeyCode>());
                _camYaw = float.NaN;
                _watchdogFired = true;
            }
            VKeys.Driving = Time.unscaledTime - _lastCmd <= WATCHDOG;
            if (!float.IsNaN(_camYaw) && CameraFunction._current != null) CameraFunction._current._RotY = _camYaw;
            if (Time.unscaledTime >= _nextTick)
            {
                _nextTick = Time.unscaledTime + TICK;
                try { Send(); } catch (Exception e) { _lastError = "tx: " + e.Message; }
            }
        }

        void Receive()
        {
            while (_rx.Available > 0)
            {
                IPEndPoint src = null;
                string line = Encoding.ASCII.GetString(_rx.Receive(ref src)).Trim();
                string[] p = line.Split(' ');
                if (p[0] == "K" && p.Length >= 2)
                {
                    var next = new HashSet<KeyCode>();
                    if (p.Length >= 3)
                        foreach (string n in p[2].Split(','))
                            if (n.Length > 0 && Enum.TryParse(n, out KeyCode k)) next.Add(k);
                    VKeys.Set(next);
                    _camYaw = p.Length >= 4 && float.TryParse(p[3], NumberStyles.Float, CultureInfo.InvariantCulture, out float y) ? y : float.NaN;
                    _seq = long.Parse(p[1]);
                    _seqFrame = Time.frameCount;
                    _lastCmd = Time.unscaledTime;
                    _watchdogFired = false;
                }
                else if (p[0] == "ENTER" && p.Length == 2) EnterGame(int.Parse(p[1]));
                else if (p[0] == "RESPAWN") Respawn();
            }
        }

        void EnterGame(int slot)
        {
            var mm = MainMenuManager._current;
            var pd = ProfileDataManager._current;
            if (mm == null || pd == null || Player._mainPlayer != null) { _lastError = "ENTER ignored: not in main menu"; return; }
            if (slot < 0 || slot >= pd._characterFiles.Length || pd._characterFiles[slot] == null || pd._characterFiles[slot]._isEmptySlot)
            { _lastError = "ENTER ignored: slot " + slot + " is empty"; return; }
            mm.Set_HostMode((int)NetworkInitCondition.Singleplayer);   // single player only, never a lobby
            mm._menuInputBuffer = 0f;
            pd.Set_FileIndex(slot);
            mm._characterSelectManager.Select_CharacterFile();
            _lastError = "";
        }

        void Respawn()
        {
            var d = FindObjectOfType<DeathPromptManager>();
            if (d != null) d.Init_ReleaseSoul();
        }

        static string F(float v) { return v.ToString("0.###", CultureInfo.InvariantCulture); }
        static string S(string s) { return "\"" + (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""; }
        static string V(Vector3 v) { return "[" + F(v.x) + "," + F(v.y) + "," + F(v.z) + "]"; }

        void Send()
        {
            var sb = _sb; sb.Length = 0;
            Player p = Player._mainPlayer;
            sb.Append("{\"frame\":").Append(Time.frameCount)
              .Append(",\"t\":").Append(F(Time.unscaledTime))
              .Append(",\"dt\":").Append(F(Time.unscaledDeltaTime))
              .Append(",\"seq\":").Append(_seq)
              .Append(",\"seq_frame\":").Append(_seqFrame)
              .Append(",\"watchdog\":").Append(_watchdogFired ? "true" : "false")
              .Append(",\"focused\":").Append(Application.isFocused ? "true" : "false")
              .Append(",\"error\":").Append(S(_lastError))
              .Append(",\"pad_override\":").Append(VKeys.Driving ? "true" : "false")
              .Append(",\"in_menu\":").Append(MainMenuManager._current != null && p == null ? "true" : "false");
            sb.Append(",\"held\":[");
            bool first = true;
            foreach (var k in VKeys.Held) { if (!first) sb.Append(','); first = false; sb.Append(S(k.ToString())); }
            sb.Append(']');

            var icm = InputControlManager.current;
            if (icm != null)
            {
                sb.Append(",\"input_mode\":").Append(S(icm._setGamepadType.ToString())).Append(",\"keys\":{\"up\":").Append(S(icm._up.ToString())).Append(",\"down\":").Append(S(icm._down.ToString()))
                  .Append(",\"left\":").Append(S(icm._left.ToString())).Append(",\"right\":").Append(S(icm._right.ToString()))
                  .Append(",\"attack\":").Append(S(icm._attack.ToString())).Append(",\"jump\":").Append(S(icm._jump.ToString()))
                  .Append(",\"dash\":").Append(S(icm._dash.ToString())).Append(",\"block\":").Append(S(icm._block.ToString()))
                  .Append(",\"interact\":").Append(S(icm._interact.ToString()))
                  .Append(",\"consumables\":[").Append(S(icm._consumableSlot_0.ToString())).Append(',').Append(S(icm._consumableSlot_1.ToString()))
                  .Append(',').Append(S(icm._consumableSlot_2.ToString())).Append(',').Append(S(icm._consumableSlot_3.ToString())).Append("]}");
            }

            if (p != null && p._statusEntity != null && p._pStats != null)
            {
                if (Time.unscaledTime >= _nextScan)
                {
                    _nextScan = Time.unscaledTime + 0.25f;
                    _creeps = FindObjectsOfType<Creep>();
                    _items = FindObjectsOfType<ItemObject>();
                    _portals = FindObjectsOfType<Portal>();
                }
                Vector3 pos = p.transform.position;
                var cam = CameraFunction._current != null ? CameraFunction._current._mainCamera : null;
                sb.Append(",\"player\":{\"name\":").Append(S(p._nickname))
                  .Append(",\"map\":").Append(S(p._mapName))
                  .Append(",\"pos\":").Append(V(pos))
                  .Append(",\"yaw\":").Append(F(p.transform.eulerAngles.y))
                  .Append(",\"cam_yaw\":").Append(cam != null ? F(cam.transform.eulerAngles.y) : "null")
                  .Append(",\"hp\":").Append(p._statusEntity._currentHealth)
                  .Append(",\"max_hp\":").Append(p._pStats._statStruct._maxHealth)
                  .Append(",\"mp\":").Append(p._statusEntity._currentMana)
                  .Append(",\"stamina\":").Append(p._statusEntity._currentStamina)
                  .Append(",\"level\":").Append(p._pStats._currentLevel)
                  .Append(",\"condition\":").Append(S(p._currentPlayerCondition.ToString()))
                  .Append(",\"action\":").Append(S(p._currentPlayerAction.ToString()))
                  .Append(",\"game\":").Append(S(p._currentGameCondition.ToString()))
                  .Append(",\"in_ui\":").Append(p._inUI ? "true" : "false")
                  .Append('}');

                var pc = p._pCombat;
                if (pc != null)
                {
                    var tr = Traverse.Create(pc);
                    sb.Append(",\"combat\":{\"sheath\":").Append(S(pc._currentSheathCondition.ToString()))
                      .Append(",\"weapon\":").Append(S(pc._equippedWeapon != null ? pc._equippedWeapon.name : ""))
                      .Append(",\"weapon_type\":").Append(S(pc._currentScriptableWeaponType != null ? pc._currentScriptableWeaponType._weaponTypeClassTag : ""))
                      .Append(",\"action_buf\":").Append(F(tr.Field("_actionBuffer").GetValue<float>()))
                      .Append(",\"attack_buf\":").Append(F(pc._attackControlBuffer))
                      .Append(",\"lock_buf\":").Append(F(pc._lockControlBuffer))
                      .Append(",\"focus_buf\":").Append(F(pc._focusWindowBuffer))
                      .Append(",\"in_queue\":").Append(tr.Field("_withinAttackQueue").GetValue<bool>() ? "true" : "false")
                      .Append(",\"hurt\":").Append(p._isHurt ? "true" : "false")
                      .Append(",\"dmg_buf\":").Append(p._statusEntity._isDamageBuffer ? "true" : "false")
                      .Append(",\"latency\":").Append(p._latency)
                      .Append(",\"grounded\":").Append(p._pMove != null && p._pMove.RayGroundCheck() ? "true" : "false")
                      .Append(",\"move_action\":").Append(S(p._pMove != null ? p._pMove._currentMovementAction.ToString() : ""))
                      .Append(",\"casting\":").Append(p._pCasting != null && (p._pCasting._isQueuedSkill || p._pCasting._currentCastSkill) ? "true" : "false");
                    // every bool/float field of PlayerCombat that is set or counting: finds which gate blocks an attack
                    sb.Append(",\"flags\":{");
                    bool ff = true;
                    foreach (var fi in typeof(PlayerCombat).GetFields(System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.DeclaredOnly))
                    {
                        string v = null;
                        if (fi.FieldType == typeof(bool)) { if ((bool)fi.GetValue(pc)) v = "true"; }
                        else if (fi.FieldType == typeof(float)) { float f = (float)fi.GetValue(pc); if (f != 0f) v = F(f); }
                        else if (fi.FieldType == typeof(int)) { int n = (int)fi.GetValue(pc); if (n != 0) v = n.ToString(); }
                        if (v == null) continue;
                        if (!ff) sb.Append(','); ff = false;
                        sb.Append(S(fi.Name)).Append(':').Append(v);
                    }
                    sb.Append("}}");
                }

                sb.Append(",\"heal_slots\":[");
                first = true;
                var bar = QuickItemActionBarGUI._current;
                if (bar != null && GameManager._current != null)
                    for (int i = 0; i < bar._quickItemSlots.Length && i < 4; i++)
                    {
                        var s = bar._quickItemSlots[i];
                        if (s == null || string.IsNullOrEmpty(s._setItemName) || s._quantityFound <= 0) continue;
                        var c = GameManager._current.Locate_Item(s._setItemName) as ScriptableStatusConsumable;
                        if (c == null || c._healthApply <= 0) continue;
                        if (!first) sb.Append(','); first = false;
                        sb.Append("{\"slot\":").Append(i).Append(",\"item\":").Append(S(s._setItemName))
                          .Append(",\"qty\":").Append(s._quantityFound).Append(",\"heals\":").Append(c._healthApply).Append('}');
                    }
                sb.Append(']');

                sb.Append(",\"creeps\":[");
                first = true;
                foreach (var c in _creeps)
                {
                    if (c == null || c._statusEntity == null || c._currentCreepCondition != CreepCondition.ACTIVE) continue;
                    if (c.gameObject.scene != p.gameObject.scene) continue;   // other zones stay loaded additively
                    Vector3 cp = c.transform.position;
                    float d = Vector3.Distance(pos, cp);
                    if (d > CREEP_RADIUS) continue;
                    if (!first) sb.Append(','); first = false;
                    sb.Append("{\"id\":").Append(c.netId)
                      .Append(",\"name\":").Append(S(c._creepDisplayName))
                      .Append(",\"level\":").Append(c._creepLevel)
                      .Append(",\"pos\":").Append(V(cp))
                      .Append(",\"dist\":").Append(F(d))
                      .Append(",\"hp\":").Append(c._statusEntity._currentHealth)
                      .Append(",\"max_hp\":").Append(c._statStruct._maxHealth)
                      .Append(",\"hostile\":").Append(c._scriptCreep != null && c._scriptCreep._canAggro ? "true" : "false")
                      .Append(",\"targetable\":").Append(c._isTargetable ? "true" : "false")
                      .Append(",\"aggro_on_me\":").Append(c._aggroedEntity != null && c._aggroedEntity == p._statusEntity ? "true" : "false")
                      .Append('}');
                }
                sb.Append(']');

                sb.Append(",\"items\":[");
                first = true;
                foreach (var it in _items)
                {
                    if (it == null || !it.gameObject.activeInHierarchy || it.gameObject.scene != p.gameObject.scene) continue;
                    float d = Vector3.Distance(pos, it.transform.position);
                    if (d > RADIUS) continue;
                    if (!first) sb.Append(','); first = false;
                    sb.Append("{\"pos\":").Append(V(it.transform.position)).Append(",\"dist\":").Append(F(d)).Append('}');
                }
                sb.Append(']');

                sb.Append(",\"portals\":[");
                first = true;
                foreach (var po in _portals)
                {
                    if (po == null || po._scenePortal == null || !po._isPortalOpen || po._netDisablePortal) continue;
                    if (po.gameObject.scene != p.gameObject.scene) continue;
                    if (!first) sb.Append(','); first = false;
                    sb.Append("{\"to\":").Append(S(po._scenePortal._portalCaptionTitle ?? ""))
                      .Append(",\"type\":").Append(S(po._scenePortal._portalType.ToString()))
                      .Append(",\"pos\":").Append(V(po.transform.position))
                      .Append(",\"dist\":").Append(F(Vector3.Distance(pos, po.transform.position))).Append('}');
                }
                sb.Append(']');
            }
            sb.Append('}');
            byte[] b = Encoding.UTF8.GetBytes(sb.ToString());
            if (b.Length < 60000) _tx.Send(b, b.Length, _dst);
        }
    }
}
