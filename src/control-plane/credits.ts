/** Account-wide snapshots, never inferred from model pricing. No secrets persisted. */
export class CreditBalance {
  balance: number | null = null;
  delta: number | null = null;
  status = "loading";
  private queue = Promise.resolve();
  private baseline: number | null = null;
  private reportedCost = 0;
  private trackingTurn = false;
  private pendingStartSnapshot = false;

  private read: () => Promise<number>;
  private changed: () => void;
  constructor(read: () => Promise<number>, changed: () => void) {
    this.read = read;
    this.changed = changed;
  }

  refresh(phase: "idle" | "start" | "live" | "end"): Promise<void> {
    if (phase === "start") {
      // Capture the value already visible in the footer immediately. The
      // network snapshot can arrive after the first streamed response.
      this.baseline = this.visibleBalance();
      this.reportedCost = 0;
      this.trackingTurn = true;
      this.pendingStartSnapshot = true;
      this.delta = null;
    }
    this.queue = this.queue.then(async () => {
      try {
        const value = await this.read();
        if (!Number.isFinite(value)) throw new Error("Invalid balance");
        this.balance = value;
        this.status = "ready";
        if (phase === "start" && this.reportedCost === 0) {
          // Prefer the fresh start snapshot while no completed response has
          // made it stale. Once costs exist, keep the captured baseline.
          this.baseline = value;
          this.delta = null;
          this.pendingStartSnapshot = false;
        } else {
          // Balance can only fall from spending, so a reading above the
          // baseline means credits were added. Without this the projection
          // floor (baseline - reportedCost) pins the footer to the
          // pre-top-up number until the next prompt rebaselines. Only
          // matters while a cost projection is active; with no reported cost
          // visibleBalance already returns the raw balance and the top-up
          // shows as a positive delta.
          if (this.reportedCost > 0 && this.baseline !== null && value > this.baseline + 0.0000005) {
            this.baseline = value;
          }
          this.updateDelta();
        }
      } catch {
        this.status = this.balance === null ? "unavailable" : "stale";
        this.pendingStartSnapshot = false;
        if (phase === "start" && this.reportedCost === 0) this.delta = null;
        else this.updateDelta();
      }
      this.changed();
    });
    return this.queue;
  }

  /** Apply exact cost reported on a completed OpenRouter assistant message.
   * Endpoint snapshots later reconcile account-wide usage and remove the
   * projection marker once billing catches up. */
  recordCost(cost: number): void {
    if (!this.trackingTurn || !Number.isFinite(cost) || cost <= 0) return;
    this.reportedCost += cost;
    this.updateDelta();
    this.changed();
  }

  needsReconciliation(): boolean {
    return this.formattedBalance()?.projected ?? false;
  }

  private visibleBalance(): number | null {
    if (this.balance === null) return null;
    if (this.baseline === null) return this.balance;
    if (!this.pendingStartSnapshot && this.reportedCost === 0) return this.balance;
    return Math.min(this.balance, this.baseline - this.reportedCost);
  }

  private updateDelta(): void {
    const visible = this.visibleBalance();
    this.delta = this.baseline === null || visible === null ? null : visible - this.baseline;
  }

  private formattedBalance(): { value: number; projected: boolean } | null {
    const value = this.visibleBalance();
    if (value === null) return null;
    return { value, projected: this.balance !== null && value < this.balance - 0.0000005 };
  }

  text(): string {
    const display = this.formattedBalance();
    if (display === null) return `OpenRouter ${this.status}`;
    const delta = this.delta === null ? "" : ` · Δ ${this.delta < 0 ? "−" : "+"}$${Math.abs(this.delta).toFixed(4)}`;
    return `OpenRouter ${display.projected ? "~" : ""}$${display.value.toFixed(2)}${delta}${this.status === "stale" ? " (stale)" : ""}`;
  }

  /** Status-bar form: balance plus the last turn's signed delta (Δ ±$0.00)
   * once it is known; a stale balance shows the stale label instead. */
  compact(): string {
    const display = this.formattedBalance();
    if (display === null) return `OpenRouter ${this.status}`;
    const delta = this.delta === null ? "" : ` · Δ ${this.delta < 0 ? "−" : "+"}$${Math.abs(this.delta).toFixed(2)}`;
    return `OpenRouter · ${display.projected ? "~" : ""}$${display.value.toFixed(2)}${delta}${this.status === "stale" ? " (stale)" : ""}`;
  }
}

/** Extract billed cost only from completed OpenRouter assistant messages. */
export function openRouterMessageCost(message: unknown): number | null {
  if (message === null || typeof message !== "object") return null;
  const value = message as {
    role?: unknown;
    provider?: unknown;
    usage?: { cost?: { total?: unknown } };
  };
  const total = value.usage?.cost?.total;
  return value.role === "assistant" && value.provider === "openrouter" &&
    typeof total === "number" && Number.isFinite(total) && total >= 0
    ? total
    : null;
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
