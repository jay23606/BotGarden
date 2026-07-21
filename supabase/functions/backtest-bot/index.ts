import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const fromB64 = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

async function key() {
  const raw = fromB64(Deno.env.get("BG_CREDENTIALS_KEY") || "");
  if (raw.length !== 32) throw new Error("Credential encryption is not configured");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
}
async function decrypt(ciphertext: string, iv: string, cryptoKey: CryptoKey) {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv) }, cryptoKey, fromB64(ciphertext));
  return new TextDecoder().decode(plain);
}

type Bar = { t: string; o: number; h: number; l: number; c: number; v: number; vw?: number };
const avg = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const sma = (bars: Bar[], end: number, period: number) => avg(bars.slice(Math.max(0, end - period + 1), end + 1).map((bar) => bar.c));
function emaValues(bars: Bar[], period: number) { const k = 2 / (period + 1); const out: number[] = []; bars.forEach((bar, i) => out.push(i ? bar.c * k + out[i - 1] * (1 - k) : bar.c)); return out; }
function rsi(bars: Bar[], end: number, period: number) { if (end < period) return 50; let gains = 0, losses = 0; for (let i = end - period + 1; i <= end; i++) { const d = bars[i].c - bars[i - 1].c; if (d >= 0) gains += d; else losses -= d; } return losses === 0 ? 100 : 100 - 100 / (1 + gains / losses); }
function atr(bars: Bar[], end: number, period: number) { if (end < 1) return 0; const values: number[] = []; for (let i = Math.max(1, end - period + 1); i <= end; i++) values.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c))); return avg(values); }

function conditionMatches(condition: any, bars: Bar[], i: number, cache: Record<string, number[]>) {
  const p = condition.parameters || {}; const bar = bars[i]; if (!bar) return false;
  if (condition.type === "immediate") return true;
  if (condition.type === "price") return p.operator === "above" ? bar.c > p.value : bar.c < p.value;
  if (condition.type === "volume") return p.operator === "above" ? bar.v > p.value : bar.v < p.value;
  if (condition.type === "percent_change") { const first = bars.findIndex((item) => item.t.slice(0, 10) === bar.t.slice(0, 10)); const anchor = p.anchor === "session_open" ? bars[first]?.o : p.anchor === "previous_close" ? bars[Math.max(0, first - 1)]?.c : bars[Math.max(0, i - 1)].c; const change = (bar.c / (anchor || bar.c) - 1) * 100; return p.operator === "above" ? change >= p.value : change <= -p.value; }
  if (condition.type === "rsi") { const value = rsi(bars, i, Number(p.period)); return p.operator === "above" ? value > p.value : value < p.value; }
  if (condition.type === "vwap") return p.operator === "above" ? bar.c > cache.sessionVwap[i] : bar.c < cache.sessionVwap[i];
  if (condition.type === "moving_average") { const fast = p.average === "sma" ? sma(bars, i, p.fast) : cache[`ema${p.fast}`][i]; const slow = p.average === "sma" ? sma(bars, i, p.slow) : cache[`ema${p.slow}`][i]; return p.operator === "above" ? fast > slow : fast < slow; }
  if (condition.type === "relative_volume") { const baseline = avg(bars.slice(Math.max(0, i - p.lookback), i).map((item) => item.v)); const ratio = baseline ? bar.v / baseline : 0; return p.operator === "above" ? ratio > p.value : ratio < p.value; }
  if (condition.type === "bollinger") { const values = bars.slice(Math.max(0, i - p.period + 1), i + 1).map((item) => item.c); const mean = avg(values); const sd = Math.sqrt(avg(values.map((value) => (value - mean) ** 2))); const lower = mean - p.deviations * sd, upper = mean + p.deviations * sd; return p.operator === "below_lower" ? bar.c < lower : p.operator === "above_upper" ? bar.c > upper : p.operator === "above_lower" ? bar.c > lower : bar.c < upper; }
  if (condition.type === "atr") { const value = atr(bars, i, p.period) / bar.c * 100; return p.operator === "above" ? value > p.value : value < p.value; }
  if (condition.type === "macd") { const macd = cache[`ema${p.fast}`][i] - cache[`ema${p.slow}`][i]; const series = cache[`macd${p.fast}-${p.slow}-${p.signal}`]; const signal = series[i]; return p.operator === "bullish" ? macd > signal : macd < signal; }
  if (condition.type === "opening_range") { const date = bar.t.slice(0, 10); const dayBars = bars.filter((item) => item.t.slice(0, 10) === date); const rangeBars = dayBars.slice(0, Math.max(1, Number(p.minutes) / 5)); const high = Math.max(...rangeBars.map((item) => item.h)), low = Math.min(...rangeBars.map((item) => item.l)); return p.operator === "above" ? bar.c > high : bar.c < low; }
  if (condition.type === "gap") { const date = bar.t.slice(0, 10); const first = bars.findIndex((item) => item.t.slice(0, 10) === date); if (first <= 0) return false; const gap = (bars[first].o / bars[first - 1].c - 1) * 100; return p.operator === "up" ? gap >= p.value : gap <= -p.value; }
  return false;
}

function prepareCache(bars: Bar[], conditions: any[]) {
  const cache: Record<string, number[]> = {}; const periods = new Set<number>();
  let activeDate = "", cumulativeValue = 0, cumulativeVolume = 0; cache.sessionVwap = bars.map((bar) => { const date = bar.t.slice(0, 10); if (date !== activeDate) { activeDate = date; cumulativeValue = 0; cumulativeVolume = 0; } cumulativeValue += (bar.vw || bar.c) * bar.v; cumulativeVolume += bar.v; return cumulativeVolume ? cumulativeValue / cumulativeVolume : bar.c; });
  conditions.forEach((condition) => { const p = condition.parameters || {}; if (["moving_average", "macd"].includes(condition.type)) { periods.add(Number(p.fast)); periods.add(Number(p.slow)); } });
  periods.forEach((period) => cache[`ema${period}`] = emaValues(bars, period));
  conditions.filter((condition) => condition.type === "macd").forEach((condition) => { const p = condition.parameters; const macd = bars.map((_, i) => cache[`ema${p.fast}`][i] - cache[`ema${p.slow}`][i]); const k = 2 / (Number(p.signal) + 1); const signal: number[] = []; macd.forEach((value, i) => signal.push(i ? value * k + signal[i - 1] * (1 - k) : value)); cache[`macd${p.fast}-${p.slow}-${p.signal}`] = signal; });
  return cache;
}

function classifyMarket(bars: Bar[]) {
  if (bars.length < 2) return { regime: "Insufficient data", returnPct: 0, volatility: "Unknown" };
  const returnPct = (bars.at(-1)!.c / bars[0].o - 1) * 100;
  const path = bars.slice(1).reduce((sum, bar, index) => sum + Math.abs(bar.c - bars[index].c), 0);
  const efficiency = path ? Math.abs(bars.at(-1)!.c - bars[0].o) / path : 0;
  const averageRangePct = avg(bars.map((bar) => (bar.h - bar.l) / bar.c * 100));
  const volatility = averageRangePct < .2 ? "Low" : averageRangePct < .5 ? "Moderate" : "High";
  const direction = returnPct > .5 ? "Bullish" : returnPct < -.5 ? "Bearish" : "Sideways";
  const regime = direction === "Sideways" && efficiency < .25 ? "Range-bound" : efficiency > .35 ? `${direction} trending` : `${direction} choppy`;
  return { regime, returnPct, volatility };
}

function estimateOptionReplay(bot: any, bars: Bar[], entries: number[], option: any) {
  const premium = Number(option.target_premium || option.minimum_credit), width = Number(option.target_width), delta = Number(option.short_delta_target), contracts = Number(option.contracts), direction = bot.direction === "short" ? -1 : 1, family = option.strategy_family || "credit_spread"; let estimatedPnl = 0, nextEntry = 0;
  for (const entryIndex of entries) { if (entryIndex < nextEntry) continue; const entry = bars[entryIndex], slippage = premium * Number(option.max_bid_ask_pct) / 200; let tradePnl = 0, exitIndex = bars.length - 1;
    for (let i = entryIndex + 1; i < bars.length; i++) { const elapsedDays = Math.max(1 / 24, (new Date(bars[i].t).valueOf() - new Date(entry.t).valueOf()) / 86400000), remainingDte = Number(option.max_dte) - elapsedDays, move = (bars[i].c - entry.c) * direction, theta = premium * Math.min(1, elapsedDays / Number(option.max_dte)); let perContract = delta * move - theta - slippage;
      if (family === "credit_spread") perContract = Math.max(-(width - premium), Math.min(premium, delta * move + theta - slippage)); else if (family === "debit_spread") perContract = Math.max(-premium, Math.min(width - premium, perContract)); else perContract = Math.max(-premium, perContract); tradePnl = perContract * 100 * contracts;
      const profitTarget = premium * 100 * contracts * Number(option.profit_close_pct) / 100, lossLimit = Math.min(Number(option.max_risk), premium * 100 * contracts * Number(option.loss_close_multiple)); if (tradePnl >= profitTarget || tradePnl <= -lossLimit || remainingDte <= Number(option.exit_dte) || i === bars.length - 1) { exitIndex = i; break; }
    }
    estimatedPnl += tradePnl; nextEntry = exitIndex + 1;
  }
  const estimatedReturn = estimatedPnl / Number(bot.max_allocation) * 100, uncertainty = Math.max(2, Math.abs(estimatedReturn) * .4); return { estimated_pnl: estimatedPnl, estimated_return_pct: estimatedReturn, estimate_low_pct: estimatedReturn - uncertainty, estimate_high_pct: estimatedReturn + uncertainty, estimate_confidence: "low" };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  let backtestId: string | null = null; let admin: any = null;
  try {
    const authorization = request.headers.get("Authorization"); if (!authorization) return respond({ error: "Authentication required" }, 401);
    admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { data: { user } } = await admin.auth.getUser(authorization.replace(/^Bearer\s+/i, "")); if (!user) return respond({ error: "Invalid session" }, 401);
    const { botId, start, end, marketDays } = await request.json();
    let startAt = new Date(start); const endAt = new Date(end); if (!botId || isNaN(startAt.valueOf()) || isNaN(endAt.valueOf()) || endAt <= startAt) return respond({ error: "Valid bot and date range required" }, 400);
    if (!marketDays && endAt.valueOf() - startAt.valueOf() > 31 * 86400000) return respond({ error: "Backtests are limited to 31 days per run" }, 400); if (marketDays && (Number(marketDays) < 1 || Number(marketDays) > 60)) return respond({ error: "Automatic tests support 1–60 market days" }, 400);
    const { data: bot } = await admin.from("bg_bots").select("*").eq("id", botId).eq("user_id", user.id).single(); if (!bot) return respond({ error: "Bot not found" }, 404);
    const { data: connection } = await admin.from("bg_broker_connections").select("id").eq("user_id", user.id).eq("broker", "alpaca").eq("environment", "paper").eq("status", "connected").single(); if (!connection) return respond({ error: "Connect Alpaca before backtesting" }, 400);
    const { data: credential } = await admin.from("bg_broker_credentials").select("*").eq("connection_id", connection.id).single(); const cryptoKey = await key();
    const [apiKey, apiSecret] = await Promise.all([decrypt(credential.api_key_ciphertext, credential.api_key_iv, cryptoKey), decrypt(credential.api_secret_ciphertext, credential.api_secret_iv, cryptoKey)]);
    if (marketDays) { const calendar = await fetch(`https://paper-api.alpaca.markets/v2/calendar?start=${startAt.toISOString().slice(0, 10)}&end=${endAt.toISOString().slice(0, 10)}`, { headers: { "APCA-API-KEY-ID": apiKey, "APCA-API-SECRET-KEY": apiSecret } }); if (!calendar.ok) throw new Error("Unable to load Alpaca market calendar"); const sessions = await calendar.json(); const selected = sessions.slice(-Number(marketDays)); if (!selected.length) throw new Error("No market sessions found"); startAt = new Date(`${selected[0].date}T00:00:00Z`); }
    const conditions = bot.start_condition?.conditions || []; const timeframe = conditions[0]?.timeframe || "5Min";
    const supported = new Set(["immediate", "price", "volume", "percent_change", "rsi", "vwap", "moving_average", "relative_volume", "bollinger", "atr", "macd", "opening_range", "gap"]);
    const unsupported = conditions.filter((condition: any) => !supported.has(condition.type)).map((condition: any) => condition.type);
    if (unsupported.length) throw new Error(`Historical evaluation is not available yet for: ${[...new Set(unsupported)].join(", ")}`);
    const warmStart = new Date(startAt.valueOf() - 5 * 86400000);
    const url = new URL(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(bot.symbol)}/bars`); url.searchParams.set("timeframe", timeframe); url.searchParams.set("start", warmStart.toISOString()); url.searchParams.set("end", endAt.toISOString()); url.searchParams.set("limit", "10000"); url.searchParams.set("feed", "iex"); url.searchParams.set("adjustment", "all");
    const marketResponse = await fetch(url, { headers: { "APCA-API-KEY-ID": apiKey, "APCA-API-SECRET-KEY": apiSecret } }); if (!marketResponse.ok) throw new Error(`Alpaca market data error (${marketResponse.status})`);
    const bars: Bar[] = (await marketResponse.json()).bars || []; if (bars.length < 20) throw new Error("Not enough historical bars in this range");
    const duration = marketDays ? Number(marketDays) * 86400 : Math.floor((endAt.valueOf() - startAt.valueOf()) / 1000); const signalOnly = bot.asset_class === "option";
    const { data: backtest, error: createError } = await admin.from("bg_backtests").insert({ bot_id: bot.id, user_id: user.id, status: "running", start_at: startAt.toISOString(), end_at: endAt.toISOString(), duration_seconds: duration, initial_capital: bot.max_allocation, data_feed: "iex", methodology: signalOnly ? "Underlying-signal coverage only; no option P&L modeled." : "Long-only bar simulation; no fees or slippage; entries and exits use bar prices." }).select("id").single(); if (createError) throw createError; backtestId = backtest.id;
    const cache = prepareCache(bars, conditions); let cash = Number(bot.max_allocation), position: any = null, signals = 0, peak = cash, maxDrawdown = 0; const trades: any[] = [], signalEntries: number[] = []; let lastSignalDate = "";
    const { data: steps } = await admin.from("bg_averaging_steps").select("*").eq("bot_id", bot.id).order("step_number");
    for (let i = 30; i < bars.length; i++) {
      if (new Date(bars[i].t) < startAt) continue;
      const matches = conditions.length && (bot.start_condition.operator === "OR" ? conditions.some((c: any) => conditionMatches(c, bars, i, cache)) : conditions.every((c: any) => conditionMatches(c, bars, i, cache)));
      if (matches) { signals++; if (signalOnly && bars[i].t.slice(0, 10) !== lastSignalDate) { signalEntries.push(i); lastSignalDate = bars[i].t.slice(0, 10); } }
      if (signalOnly) continue;
      const bar = bars[i];
      if (!position && matches) { const amount = Math.min(cash, Number(steps?.[0]?.order_amount || bot.max_allocation)); position = { entryAt: bar.t, base: bar.c, qty: amount / bar.c, cost: amount, next: 1 }; cash -= amount; }
      if (position) {
        while (position.next < (steps?.length || 0)) { const step = steps[position.next]; const trigger = position.base * (1 - Number(step.deviation_pct) / 100); if (bar.l > trigger || cash < Number(step.order_amount)) break; position.qty += Number(step.order_amount) / trigger; position.cost += Number(step.order_amount); cash -= Number(step.order_amount); position.next++; }
        const average = position.cost / position.qty; let exit = 0, reason = "";
        if (bar.h >= average * (1 + Number(bot.take_profit_pct) / 100)) { exit = average * (1 + Number(bot.take_profit_pct) / 100); reason = "take_profit"; }
        else if (bot.stop_loss_pct && bar.l <= position.base * (1 - Number(bot.stop_loss_pct) / 100)) { exit = position.base * (1 - Number(bot.stop_loss_pct) / 100); reason = "stop_loss"; }
        if (exit) { const proceeds = position.qty * exit, pnl = proceeds - position.cost; cash += proceeds; trades.push({ backtest_id: backtestId, user_id: user.id, entry_at: position.entryAt, exit_at: bar.t, entry_price: average, exit_price: exit, quantity: position.qty, pnl, exit_reason: reason }); position = null; }
        const equity = cash + (position ? position.qty * bar.c : 0); peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak ? (peak - equity) / peak * 100 : 0);
      }
    }
    if (!signalOnly && position) { const bar = bars[bars.length - 1], average = position.cost / position.qty, proceeds = position.qty * bar.c, pnl = proceeds - position.cost; cash += proceeds; trades.push({ backtest_id: backtestId, user_id: user.id, entry_at: position.entryAt, exit_at: bar.t, entry_price: average, exit_price: bar.c, quantity: position.qty, pnl, exit_reason: "end_of_test" }); }
    if (trades.length) await admin.from("bg_backtest_trades").insert(trades);
    const testBars = bars.filter((bar) => new Date(bar.t) >= startAt); const market = classifyMarket(testBars);
    const days = new Map<string, Bar[]>(); testBars.forEach((bar) => { const date = bar.t.slice(0, 10); days.set(date, [...(days.get(date) || []), bar]); });
    const dailyRegimes = [...days.entries()].map(([date, dayBars]) => { const summary = classifyMarket(dayBars); return { date, regime: summary.regime, return_pct: summary.returnPct, volatility: summary.volatility, open_price: dayBars[0]?.o, close_price: dayBars.at(-1)?.c }; });
    const pnl = signalOnly ? null : cash - Number(bot.max_allocation); const wins = trades.filter((trade) => trade.pnl > 0).length; let estimate: any = {};
    if (signalOnly) { const { data: option } = await admin.from("bg_option_spreads").select("*").eq("bot_id", bot.id).maybeSingle(); if (option && signalEntries.length) estimate = estimateOptionReplay(bot, bars, signalEntries, option); }
    const result = { status: signalOnly ? "signal_only" : "completed", ending_capital: signalOnly ? null : cash, net_pnl: pnl, return_pct: signalOnly ? null : pnl / Number(bot.max_allocation) * 100, max_drawdown_pct: signalOnly ? null : maxDrawdown, trade_count: trades.length, win_count: wins, loss_count: trades.length - wins, signal_count: signals, ...estimate, market_regime: market.regime, market_return_pct: market.returnPct, volatility_label: market.volatility, daily_regimes: dailyRegimes, completed_at: new Date().toISOString() };
    await admin.from("bg_backtests").update(result).eq("id", backtestId); return respond({ id: backtestId, ...result, duration_seconds: duration });
  } catch (error) {
    if (admin && backtestId) await admin.from("bg_backtests").update({ status: "failed", error_message: error instanceof Error ? error.message : "Backtest failed", completed_at: new Date().toISOString() }).eq("id", backtestId);
    return respond({ error: error instanceof Error ? error.message : "Backtest failed" }, 500);
  }
});
