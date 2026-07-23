export const normalizeSymbol = (value) => String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

export function optionUnderlying(symbol) {
  const match = normalizeSymbol(symbol).match(/^([A-Z]{1,6})\d{6}[CP]\d{8}$/);
  return match?.[1] || null;
}

export const optionMatchesUnderlying = (optionSymbol, underlying) => optionUnderlying(optionSymbol) === normalizeSymbol(underlying);

export function cooldownRemainingMs(lastExitFillAt, cooldownSeconds, now = Date.now()) {
  if (!lastExitFillAt || Number(cooldownSeconds) <= 0) return 0;
  return Math.max(0, Number(cooldownSeconds) * 1000 - (Number(now) - new Date(lastExitFillAt).valueOf()));
}

export function boundedEntryNotional(requested, maxAllocation, currentExposure) {
  return Math.max(0, Math.min(Number(requested) || 0, (Number(maxAllocation) || 0) - Math.max(0, Number(currentExposure) || 0)));
}

export function portfolioEntryAssessment({ equity, lastEquity, positions = [], openOrders = [], symbol, plannedExposure = 0, limits = {} }) {
  const accountEquity = Math.max(0, Number(equity) || 0), priorEquity = Math.max(0, Number(lastEquity) || accountEquity), key = normalizeSymbol(symbol);
  const gross = positions.reduce((sum, position) => sum + Math.abs(Number(position.market_value) || 0), 0);
  const symbolExposure = positions.filter((position) => normalizeSymbol(position.symbol) === key || optionUnderlying(position.symbol) === key).reduce((sum, position) => sum + Math.abs(Number(position.market_value) || 0), 0);
  const pending = openOrders.reduce((sum, order) => sum + Math.abs(Number(order.notional) || (order.legs?.length ? (Number(order.qty) || 1) * 500 : (Number(order.qty) || 0) * (Number(order.limit_price) || Number(order.stop_price) || 0))), 0);
  const projectedGrossPct = accountEquity ? (gross + pending + Math.max(0, Number(plannedExposure) || 0)) / accountEquity * 100 : Infinity;
  const projectedSymbolPct = accountEquity ? (symbolExposure + Math.max(0, Number(plannedExposure) || 0)) / accountEquity * 100 : Infinity;
  const dailyPnlPct = priorEquity ? (accountEquity / priorEquity - 1) * 100 : 0;
  const thresholds = { maxGrossPct: Number(limits.maxGrossPct ?? 75), maxSymbolPct: Number(limits.maxSymbolPct ?? 20), maxDailyLossPct: Number(limits.maxDailyLossPct ?? 3) };
  let reason = null;
  if (!accountEquity) reason = "account_equity_unavailable";
  else if (dailyPnlPct <= -thresholds.maxDailyLossPct) reason = "daily_loss_limit";
  else if (projectedGrossPct > thresholds.maxGrossPct) reason = "gross_exposure_limit";
  else if (projectedSymbolPct > thresholds.maxSymbolPct) reason = "symbol_concentration_limit";
  return { allowed: !reason, reason, gross_exposure: gross, pending_reservation: pending, projected_gross_pct: projectedGrossPct, projected_symbol_pct: projectedSymbolPct, daily_pnl_pct: dailyPnlPct, ...thresholds };
}

export function calculateBotPosition(fills, symbol, mark) {
  const lots = [];
  for (const fill of fills.filter((item) => normalizeSymbol(item.symbol) === normalizeSymbol(symbol))) {
    let remaining = (fill.side === "buy" ? 1 : -1) * Number(fill.quantity || 0);
    const price = Number(fill.price || 0);
    while (Math.abs(remaining) >= 1e-10 && lots.length && Math.sign(lots[0].quantity) !== Math.sign(remaining)) {
      const matched = Math.min(Math.abs(remaining), Math.abs(lots[0].quantity));
      lots[0].quantity += Math.sign(remaining) * matched;
      remaining -= Math.sign(remaining) * matched;
      if (Math.abs(lots[0].quantity) < 1e-10) lots.shift();
    }
    if (Math.abs(remaining) >= 1e-10) lots.push({ quantity: remaining, price });
  }
  const quantity = lots.reduce((sum, lot) => sum + lot.quantity, 0);
  const openCost = lots.reduce((sum, lot) => sum + Math.abs(lot.quantity) * lot.price, 0);
  const averageEntry = Math.abs(quantity) >= 1e-10 ? openCost / Math.abs(quantity) : 0;
  const unrealizedPnl = quantity > 0 ? (mark - averageEntry) * quantity : quantity < 0 ? (averageEntry - mark) * Math.abs(quantity) : 0;
  return { quantity, average_entry: averageEntry, open_cost: openCost, unrealized_pnl: unrealizedPnl, unrealized_pnl_pct: openCost ? unrealizedPnl / openCost * 100 : 0, mark };
}

export function staleOrderDeadline(order, entryMinutes = 15, exitMinutes = 5) {
  const intent = String(order.position_intent || ""), clientId = String(order.client_order_id || "");
  const isExit = intent.endsWith("_to_close") || (order.legs || []).some((leg) => String(leg.position_intent || "").endsWith("_to_close")) || /^(bgrx|bgsx|bgx|bgrt)-/.test(clientId);
  const submitted = new Date(order.submitted_at || order.created_at || 0).valueOf();
  return { isExit, deadline: submitted + (isExit ? exitMinutes : entryMinutes) * 60000 };
}
