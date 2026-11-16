interface TranscriptComponent {
  constructor: { name: string };
  children?: readonly TranscriptComponent[];
  render(width: number): string[];
}

interface LayoutBox {
  component: TranscriptComponent;
  rect: { width: number };
  children: readonly LayoutBox[];
  scrollView?: unknown;
}

interface TranscriptTui {
  mode?: string;
  currentLayout?: {
    root: LayoutBox;
    primaryScrollView?: { scrollTo(row: number, options: { disableFollow: boolean }): void };
  };
  requestRender(): void;
}

function lastUserOffset(component: TranscriptComponent, width: number): number | undefined {
  if (["UserMessageComponent", "SkillInvocationMessageComponent"].includes(component.constructor.name)) return 0;
  if (component.constructor.name !== "Container" || !Array.isArray(component.children)) return undefined;
  for (let i = component.children.length - 1; i >= 0; i--) {
    const offset = lastUserOffset(component.children[i], width);
    if (offset !== undefined) {
      return component.children.slice(0, i).reduce((row, child) => row + child.render(width).length, offset);
    }
  }
  return undefined;
}

export function jumpToLastUserPrompt(value: unknown): "jumped" | "no-prompt" | "unsupported" {
  // shortcut: Pi 1.4 exposes no public transcript target API; replace this layout adapter when one exists.
  const tui = value as TranscriptTui | undefined;
  const frame = tui?.currentLayout;
  const scrollView = frame?.primaryScrollView;
  if (tui?.mode !== "fullscreen" || !frame?.root || typeof scrollView?.scrollTo !== "function") return "unsupported";
  const findScrollBox = (box: LayoutBox): LayoutBox | undefined => {
    if (box.scrollView === scrollView) return box;
    for (const child of box.children ?? []) {
      const found = findScrollBox(child);
      if (found) return found;
    }
    return undefined;
  };
  const document = findScrollBox(frame.root)?.children[0];
  if (!document || typeof document.component?.render !== "function") return "unsupported";
  const row = lastUserOffset(document.component, document.rect.width);
  if (row === undefined) return "no-prompt";
  scrollView.scrollTo(row, { disableFollow: true });
  tui.requestRender();
  return "jumped";
}
