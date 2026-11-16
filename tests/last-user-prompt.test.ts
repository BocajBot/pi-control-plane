import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { resolvePiDist } from "../scripts/pi-dist.mjs";
import { jumpToLastUserPrompt } from "../src/control-plane/last-user-prompt.ts";

const dist = resolvePiDist();

test("last prompt targets latest user across scroll positions, wrapping and streaming output", { skip: !dist }, async () => {
  const load = (relative: string) => import(pathToFileURL(path.resolve(dist!, relative)).href);
  const { Container, Text } = await load("../../pi-tui/dist/index.js");
  const { renderLayoutFrame } = await load("../../pi-tui/dist/layout.js");
  const { createChatViewport } = await load("modes/interactive/chat-viewport.js");
  const { initTheme } = await load("modes/interactive/theme/theme.js");
  const { UserMessageComponent } = await load("modes/interactive/components/user-message.js");
  const { AssistantMessageComponent } = await load("modes/interactive/components/assistant-message.js");
  initTheme("dark", false);
  for (const width of [30, 90]) {
    const document = new Container();
    const chat = new Container();
    document.addChild(new Text("header", 0, 0));
    document.addChild(chat);
    chat.addChild(new UserMessageComponent("old prompt"));
    chat.addChild(new Text("old output\n".repeat(40), 0, 0));
    const latest = new UserMessageComponent("LATEST USER: wrapped Unicode 界 prompt ".repeat(8));
    const expected = document.children[0].render(width).length + chat.children.reduce((n: number, c: any) => n + c.render(width).length, 0);
    chat.addChild(latest);
    chat.addChild(new AssistantMessageComponent({ role: "assistant", content: [{ type: "text", text: "assistant output\n\n".repeat(40) }] }));
    const empty = () => new Container();
    const viewport = createChatViewport({ document, pendingMessages: empty(), status: empty(), editor: new Text("draft stays", 0, 0), footer: empty() });
    let renders = 0;
    const frame = renderLayoutFrame(viewport.root, width, 20, () => {});
    const tui = { mode: "fullscreen", currentLayout: frame, requestRender: () => { renders++; } };
    for (const position of [0, expected - 3, 100000]) {
      viewport.transcript.scrollTo(position);
      assert.equal(jumpToLastUserPrompt(tui), "jumped");
      assert.equal(viewport.transcript.scrollTop, expected);
      assert.equal(viewport.transcript.isFollowingEnd, false);
    }
    chat.addChild(new Text("streamed tool output\n".repeat(20), 0, 0));
    tui.currentLayout = renderLayoutFrame(viewport.root, width, 20, () => {});
    assert.equal(jumpToLastUserPrompt(tui), "jumped");
    assert.equal(viewport.transcript.scrollTop, expected);
    assert.equal(renders, 4);

    const { loadExtensions, createExtensionRuntime } = await load("core/extensions/loader.js");
    const loaded = await loadExtensions([path.resolve("extensions/last-user-prompt.ts")], process.cwd(), undefined, createExtensionRuntime());
    assert.deepEqual(loaded.errors, []);
    const extension = loaded.extensions[0];
    const ctx = { mode: "tui", ui: {
      setWidget: (_key: string, factory: Function, options: any) => {
        assert.equal(options.placement, "belowEditor");
        assert.deepEqual(factory(tui).render(80), []);
      },
      notify: (message: string) => assert.fail(message),
    } };
    for (const handler of extension.handlers.get("session_start")) await handler({ reason: "startup" }, ctx);
    for (const run of [() => extension.commands.get("last-prompt").handler("", ctx), () => extension.shortcuts.get("ctrl+alt+u").handler(ctx)]) {
      viewport.transcript.scrollTo(0);
      await run();
      assert.equal(viewport.transcript.scrollTop, expected);
    }
  }
});

test("regular mode, missing layout and no user prompt do not move viewport", () => {
  assert.equal(jumpToLastUserPrompt({ mode: "regular" }), "unsupported");
  assert.equal(jumpToLastUserPrompt({ mode: "fullscreen" }), "unsupported");
  const scrollView = { scrollTo: () => assert.fail("no prompt must not scroll") };
  const empty = { constructor: { name: "Container" }, children: [], render: () => [] };
  const document = { component: empty, rect: { width: 80 }, children: [] };
  const root = { component: empty, rect: { width: 80 }, children: [document], scrollView };
  assert.equal(jumpToLastUserPrompt({ mode: "fullscreen", currentLayout: { root, primaryScrollView: scrollView } }), "no-prompt");
});
