/** Account-wide snapshots, never inferred from model pricing. No secrets persisted. */
export class CreditBalance {
  balance: number | null = null;
  delta: number | null = null;
  status = "loading";
  private queue = Promise.resolve();
  private baseline: number | null = null;

  private read: () => Promise<number>;
  private changed: () => void;
  constructor(read: () => Promise<number>, changed: () => void) {
    this.read = read;
    this.changed = changed;
  }

  refresh(phase: "idle" | "start" | "end"): Promise<void> {
    this.queue = this.queue.then(async () => {
      try {
        const value = await this.read();
        if (!Number.isFinite(value)) throw new Error("Invalid balance");
        this.balance = value;
        this.status = "ready";
        if (phase === "start") { this.baseline = value; this.delta = null; }
        if (phase === "end") {
          this.delta = this.baseline === null ? null : value - this.baseline;
          this.baseline = null;
        }
      } catch {
        this.status = this.balance === null ? "unavailable" : "stale";
        this.delta = null;
        this.baseline = null;
      }
      this.changed();
    });
    return this.queue;
  }

  text(): string {
    if (this.balance === null) return `OpenRouter ${this.status}`;
    const delta = this.delta === null ? "" : ` · Δ ${this.delta < 0 ? "−" : "+"}$${Math.abs(this.delta).toFixed(4)}`;
    return `OpenRouter $${this.balance.toFixed(2)}${this.status === "stale" ? " (stale)" : delta}`;
  }

  /** Status-bar form: balance plus the last turn's signed delta (Δ ±$0.00)
   * once it is known; a stale balance shows the stale label instead. */
  compact(): string {
    if (this.balance === null) return `OpenRouter ${this.status}`;
    const delta =
      this.delta === null || this.status === "stale"
        ? ""
        : ` · Δ ${this.delta < 0 ? "−" : "+"}$${Math.abs(this.delta).toFixed(2)}`;
    return `OpenRouter · $${this.balance.toFixed(2)}${this.status === "stale" ? " (stale)" : delta}`;
  }
}

export async function readOpenRouterBalance(key: string, request: typeof fetch = fetch): Promise<number> {
  const response = await request("https://openrouter.ai/api/v1/credits", {
    headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new Error("Credits unavailable");
  const body = await response.json() as { data?: { total_credits?: unknown; total_usage?: unknown } };
  const { total_credits: credits, total_usage: usage } = body.data ?? {};
  if (typeof credits !== "number" || typeof usage !== "number" || !Number.isFinite(credits) || !Number.isFinite(usage)) {
    throw new Error("Invalid credits response");
  }
  return credits - usage;
}
