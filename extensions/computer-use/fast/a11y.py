"""AT-SPI snapshot + semantic actions (system Python; needs python-gobject)."""
import warnings
import gi
gi.require_version("Atspi", "2.0")
from gi.repository import Atspi, GLib

# get_action_name is the only per-index name accessor pygobject exposes here
# (Action.get_name collides with Accessible.get_name); silence its deprecation.
warnings.filterwarnings("ignore", category=DeprecationWarning, message=".*get_action_name.*")

# Roles an agent may act on. Static text/containers are never candidates:
# a label saying "click OK" is not the OK button (GLiNER picked exactly that
# label when labels were offered, 2026-09-29).
ACTIONABLE = {"push button", "button", "check box", "toggle button", "radio button",
              "menu item", "link", "combo box", "text", "entry", "password text"}
TEXT_ROLES = {"text", "entry", "password text"}


class Element:
    def __init__(self, idx, node, role, name, actions, extents, states):
        self.idx, self.node, self.role, self.name = idx, node, role, name
        self.actions, self.extents, self.states = actions, extents, states

    @property
    def label(self):
        kind = "text field" if self.role in TEXT_ROLES else self.role.replace("push ", "")
        return f"{kind}: {self.name}"

    def to_json(self):
        return {"idx": self.idx, "role": self.role, "name": self.name, "actions": self.actions,
                "extents": self.extents, "states": self.states}


def find_app(name):
    d = Atspi.get_desktop(0)
    hits = []
    for i in range(d.get_child_count()):
        a = d.get_child_at_index(i)
        if a is not None and (a.get_name() or "") == name and a.get_child_count():
            hits.append(a)
    return hits


def find_window(app_name, title):
    for a in find_app(app_name):
        for i in range(a.get_child_count()):
            w = a.get_child_at_index(i)
            if w is not None and (w.get_name() or "") == title:
                return w
    return None


def snapshot(root):
    """Actionable, visible, enabled, named elements under root.

    Returns (elements, skipped): skipped counts nodes that raised while being
    read. A caller that needs a complete view must treat skipped > 0 as
    "tree incomplete", not as "those controls do not exist".
    """
    out = []
    skipped = []

    def walk(n):
        if n is None:
            return
        # Per-node read in its own try: a node that errors (vanished mid-walk,
        # D-Bus hiccup) is skipped alone; its children are still visited.
        try:
            role, name = n.get_role_name(), (n.get_name() or "").strip()
            st = n.get_state_set()
            ok = (st.contains(Atspi.StateType.SHOWING) and st.contains(Atspi.StateType.VISIBLE)
                  and st.contains(Atspi.StateType.SENSITIVE) and st.contains(Atspi.StateType.ENABLED))
            if role in ACTIONABLE and name and ok:
                acts = []
                a = n.get_action_iface()
                if a:
                    acts = [a.get_action_name(i) for i in range(a.get_n_actions())]
                ext = None
                c = n.get_component_iface()
                if c:
                    e = c.get_extents(Atspi.CoordType.SCREEN)
                    ext = [e.x, e.y, e.width, e.height]
                editable = st.contains(Atspi.StateType.EDITABLE)
                if acts or editable:
                    out.append(Element(len(out), n, role, name, acts, ext,
                                       {"editable": editable, "checked": st.contains(Atspi.StateType.CHECKED)}))
        except GLib.Error:
            skipped.append(1)
        try:
            count = n.get_child_count()
        except GLib.Error:
            skipped.append(1)
            return
        for i in range(count):
            try:
                child = n.get_child_at_index(i)
            except GLib.Error:
                skipped.append(1)
                continue
            walk(child)

    walk(root)
    return out, len(skipped)


def invoke(el, action=None):
    a = el.node.get_action_iface()
    names = [a.get_action_name(i) for i in range(a.get_n_actions())]
    want = action or ("click" if "click" in names else names[0])
    return a.do_action(names.index(want))


def set_text(el, text):
    t = el.node.get_editable_text_iface()
    return t.set_text_contents(text)


def get_text(el):
    t = el.node.get_text_iface()
    return Atspi.Text.get_text(t, 0, Atspi.Text.get_character_count(t))
