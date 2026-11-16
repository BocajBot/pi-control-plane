import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { jumpToLastUserPrompt } from "../src/control-plane/last-user-prompt.ts";

export default function (pi: ExtensionAPI) {
  let tui: unknown;
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setWidget("last-user-prompt", (renderer) => {
      tui = renderer;
      return { render: () => [], invalidate() {} };
    }, { placement: "belowEditor" });
  });
  const jump = async (ctx: ExtensionContext) => {
    const result = jumpToLastUserPrompt(tui);
    if (result === "no-prompt") ctx.ui.notify("No user prompt in this transcript.", "info");
    if (result === "unsupported") ctx.ui.notify("Jump to Last User Prompt requires a supported Pi fullscreen layout.", "warning");
  };
  pi.registerCommand("last-prompt", {
    description: "Jump to Last User Prompt (ctrl+alt+u)",
    handler: async (_args, ctx) => jump(ctx),
  });
  pi.registerShortcut("ctrl+alt+u", {
    description: "Jump to Last User Prompt",
    handler: jump,
  });
}
