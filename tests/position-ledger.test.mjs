import test from "node:test";
import assert from "node:assert/strict";
import { calculateBotPosition, staleOrderDeadline } from "../supabase/functions/_shared/position-ledger.js";

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
