import test from "node:test";
import assert from "node:assert/strict";
import { boundedEntryNotional, calculateBotPosition, cooldownRemainingMs, optionMatchesUnderlying, optionUnderlying, portfolioEntryAssessment, staleOrderDeadline } from "../supabase/functions/_shared/position-ledger.js";

test("calculates a weighted long cost basis after a partial exit", () => {
  const result = calculateBotPosition([
    { symbol: "BTC/USD", side: "buy", quantity: 2, price: 100 },
    { symbol: "BTCUSD", side: "buy", quantity: 1, price: 130 },
    { symbol: "BTC/USD", side: "sell", quantity: 1.5, price: 140 },
  ], "BTC/USD", 150);
  assert.equal(result.quantity, 1.5);
  assert.equal(result.average_entry, 120);
  assert.equal(result.unrealized_pnl, 45);
  assert.equal(result.unrealized_pnl_pct, 25);
});

test("handles a short position and partial buy-to-cover", () => {
  const result = calculateBotPosition([
    { symbol: "TSLA", side: "sell", quantity: 3, price: 200 },
    { symbol: "TSLA", side: "buy", quantity: 1, price: 180 },
  ], "TSLA", 170);
  assert.equal(result.quantity, -2);
  assert.equal(result.average_entry, 200);
  assert.equal(result.unrealized_pnl, 60);
  assert.equal(result.unrealized_pnl_pct, 15);
});

test("a reversal closes prior lots before opening the opposite direction", () => {
  const result = calculateBotPosition([
    { symbol: "SPY", side: "buy", quantity: 2, price: 500 },
    { symbol: "SPY", side: "sell", quantity: 3, price: 510 },
  ], "SPY", 505);
  assert.equal(result.quantity, -1);
  assert.equal(result.average_entry, 510);
  assert.equal(result.unrealized_pnl, 5);
});

test("symbol filtering keeps another ticker out of this bot position", () => {
  const result = calculateBotPosition([
    { symbol: "LTC/USD", side: "buy", quantity: 5, price: 80 },
    { symbol: "BTC/USD", side: "buy", quantity: 1, price: 50000 },
  ], "LTCUSD", 84);
  assert.equal(result.quantity, 5);
  assert.equal(result.unrealized_pnl, 20);
});

test("exit orders become stale sooner than entry orders", () => {
  const submitted = "2026-07-22T12:00:00.000Z";
  const entry = staleOrderDeadline({ client_order_id: "bg-abc", submitted_at: submitted });
  const exit = staleOrderDeadline({ client_order_id: "bgsx-abc", submitted_at: submitted });
  assert.equal(entry.deadline - Date.parse(submitted), 15 * 60000);
  assert.equal(exit.deadline - Date.parse(submitted), 5 * 60000);
  assert.equal(exit.isExit, true);
});

test("option ownership uses the complete OCC underlying instead of a ticker prefix", () => {
  assert.equal(optionUnderlying("LTC260821C00100000"), "LTC");
  assert.equal(optionMatchesUnderlying("SPY260821P00500000", "SPY"), true);
  assert.equal(optionMatchesUnderlying("SPYG260821P00090000", "SPY"), false);
});

test("cooldown starts at the actual exit fill", () => {
  const exit = "2026-07-22T12:00:00.000Z";
  assert.equal(cooldownRemainingMs(exit, 1800, Date.parse("2026-07-22T12:10:00.000Z")), 20 * 60000);
  assert.equal(cooldownRemainingMs(exit, 1800, Date.parse("2026-07-22T12:31:00.000Z")), 0);
});

test("entry sizing never exceeds the bot allocation", () => {
  assert.equal(boundedEntryNotional(100, 500, 475), 25);
  assert.equal(boundedEntryNotional(100, 500, 510), 0);
  assert.equal(boundedEntryNotional(100, 500, 200), 100);
});

test("portfolio entry gate reserves pending orders and enforces concentration", () => {
  const result = portfolioEntryAssessment({ equity: 10000, lastEquity: 10000, symbol: "SPY", plannedExposure: 500, positions: [{ symbol: "QQQ", market_value: 5000 }, { symbol: "SPY", market_value: 1700 }], openOrders: [{ notional: 400 }] });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "gross_exposure_limit");
  assert.equal(result.pending_reservation, 400);
  assert.equal(result.projected_gross_pct, 76);
});

test("portfolio entry gate stops entries after the daily loss limit", () => {
  const result = portfolioEntryAssessment({ equity: 9600, lastEquity: 10000, symbol: "AAPL", plannedExposure: 100, positions: [] });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "daily_loss_limit");
});
