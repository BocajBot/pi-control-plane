import test from "node:test";
import assert from "node:assert/strict";
import { CreditBalance, openRouterMessageCost, readOpenRouterBalance } from "../src/control-plane/credits.ts";

test("credits serialize snapshots and show signed account delta after a prompt", async () => {
  const values = [12, 12, 11.9876, 12, 14];
  let changes = 0;
  const credit = new CreditBalance(async () => values.shift()!, () => { changes++; });
  await credit.refresh("idle");
  const start = credit.refresh("start");
  const end = credit.refresh("end");
  await Promise.all([start, end]);
  assert.match(credit.text(), /OpenRouter \$11.99 · Δ −\$0.0124/);
  assert.equal(credit.compact(), "OpenRouter · $11.99 · Δ −$0.01", "status-bar form carries the signed delta at two decimals");
  await credit.refresh("start");
  assert.equal(credit.delta, null);
  await credit.refresh("end");
  assert.match(credit.text(), /Δ \+\$2.0000/);
  assert.equal(credit.compact(), "OpenRouter · $14.00 · Δ +$2.00");
  assert.equal(changes, 5);
});

test("failed baseline never invents a per-prompt delta; stale balance labelled", async () => {
  let fail = false;
  const credit = new CreditBalance(async () => { if (fail) throw Error(); return 10; }, () => {});
  await credit.refresh("idle");
  fail = true;
  await credit.refresh("start");
  assert.match(credit.text(), /stale/);
  assert.equal(credit.compact(), "OpenRouter · $10.00 (stale)");
  assert.equal(new CreditBalance(async () => 0, () => {}).compact(), "OpenRouter loading");
  fail = false;
  await credit.refresh("end");
  assert.equal(credit.delta, 0);
  assert.equal(credit.compact(), "OpenRouter · $10.00 · Δ +$0.00");
});

test("completed response costs update balance immediately, then endpoint reconciles", async () => {
  const values = [10, 10, 9.75, 9.7];
  const credit = new CreditBalance(async () => values.shift()!, () => {});
  await credit.refresh("idle");
  await credit.refresh("start");

  credit.recordCost(0.3);
  assert.equal(credit.compact(), "OpenRouter · ~$9.70 · Δ −$0.30");

  await credit.refresh("live");
  assert.equal(credit.compact(), "OpenRouter · ~$9.70 · Δ −$0.30", "partial settlement cannot raise displayed balance");
  await credit.refresh("end");
  assert.equal(credit.compact(), "OpenRouter · $9.70 · Δ −$0.30", "settled endpoint removes projection marker");
});

test("stale endpoint keeps useful projected cost and labels uncertainty", async () => {
  let fail = false;
  const credit = new CreditBalance(async () => { if (fail) throw Error(); return 4; }, () => {});
  await credit.refresh("idle");
  await credit.refresh("start");
  credit.recordCost(0.125);
  fail = true;
  await credit.refresh("live");
  assert.equal(credit.compact(), "OpenRouter · ~$3.88 · Δ −$0.13 (stale)");
});

test("message cost accepts only completed OpenRouter assistant usage", () => {
  assert.equal(openRouterMessageCost({ role: "assistant", provider: "openrouter", usage: { cost: { total: 0.125 } } }), 0.125);
  assert.equal(openRouterMessageCost({ role: "assistant", provider: "other", usage: { cost: { total: 1 } } }), null);
  assert.equal(openRouterMessageCost({ role: "user", provider: "openrouter", usage: { cost: { total: 1 } } }), null);
  assert.equal(openRouterMessageCost({ role: "assistant", provider: "openrouter", usage: { cost: { total: Number.NaN } } }), null);
});

test("credits use fixed official endpoint and reject malformed or denied responses", async () => {
  const request = async (url: string, options: RequestInit) => {
    assert.equal(url, "https://openrouter.ai/api/v1/credits");
    assert.equal((options.headers as Record<string, string>).Authorization, "Bearer test-key");
    return new Response(JSON.stringify({data: {total_credits: 20, total_usage: 3}}));
  };
  assert.equal(await readOpenRouterBalance("test-key", request as typeof fetch), 17);
  for (const response of [new Response('{}'), new Response('', {status: 403})]) {
    await assert.rejects(readOpenRouterBalance("test-key", (async () => response) as typeof fetch));
  }
});
