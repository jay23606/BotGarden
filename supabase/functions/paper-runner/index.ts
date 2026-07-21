import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fromB64 = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
async function cryptoKey() { const raw = fromB64(Deno.env.get("BG_CREDENTIALS_KEY") || ""); if (raw.length !== 32) throw new Error("Credential encryption is not configured"); return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]); }
async function decrypt(value: string, iv: string, key: CryptoKey) { return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv) }, key, fromB64(value))); }
type Bar = { t: string; o: number; h: number; l: number; c: number; v: number; vw?: number };
const avg = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const sma = (bars: Bar[], period: number) => avg(bars.slice(-period).map((bar) => bar.c));
function ema(bars: Bar[], period: number) { const k = 2 / (period + 1); return bars.reduce((last, bar, i) => i ? bar.c * k + last * (1 - k) : bar.c, bars[0]?.c || 0); }
function rsi(bars: Bar[], period: number) { if (bars.length <= period) return 50; let gains = 0, losses = 0; for (let i = bars.length - period; i < bars.length; i++) { const d = bars[i].c - bars[i - 1].c; if (d >= 0) gains += d; else losses -= d; } return losses ? 100 - 100 / (1 + gains / losses) : 100; }
function atr(bars: Bar[], period: number) { return avg(bars.slice(-period).map((bar, i, tail) => i ? Math.max(bar.h - bar.l, Math.abs(bar.h - tail[i - 1].c), Math.abs(bar.l - tail[i - 1].c)) : bar.h - bar.l)); }
function matches(condition: any, bars: Bar[]) {
  const p = condition.parameters || {}, bar = bars.at(-1)!; const op = (value: number, target: number) => p.operator === "above" ? value > target : value < target;
  if (condition.type === "immediate") return true;
  if (condition.type === "price") return op(bar.c, Number(p.value));
  if (condition.type === "volume") return op(bar.v, Number(p.value));
  if (condition.type === "rsi") return op(rsi(bars, Number(p.period || 14)), Number(p.value));
  if (condition.type === "moving_average") { const calc = p.average === "sma" ? sma : ema; return op(calc(bars, Number(p.fast)), calc(bars, Number(p.slow))); }
  if (condition.type === "relative_volume") return op(bar.v / (avg(bars.slice(-(Number(p.lookback || 20) + 1), -1).map((b) => b.v)) || Infinity), Number(p.value));
  if (condition.type === "vwap") { const volume = bars.reduce((s, b) => s + b.v, 0); const vwap = bars.reduce((s, b) => s + (b.vw || b.c) * b.v, 0) / (volume || 1); return op(bar.c, vwap); }
  if (condition.type === "percent_change") { const anchor = p.anchor === "session_open" ? bars.find((b) => b.t.slice(0, 10) === bar.t.slice(0, 10))?.o : bars.at(-2)?.c; return op((bar.c / (anchor || bar.c) - 1) * 100, Number(p.value)); }
  if (condition.type === "atr") return op(atr(bars, Number(p.period || 14)) / bar.c * 100, Number(p.value));
  if (condition.type === "bollinger") { const values = bars.slice(-Number(p.period || 20)).map((b) => b.c), mean = avg(values), sd = Math.sqrt(avg(values.map((v) => (v - mean) ** 2))), lower = mean - Number(p.deviations || 2) * sd, upper = mean + Number(p.deviations || 2) * sd; return p.operator === "below_lower" ? bar.c < lower : p.operator === "above_upper" ? bar.c > upper : p.operator === "above_lower" ? bar.c > lower : bar.c < upper; }
  if (condition.type === "opening_range") { const today = bars.filter((b) => b.t.slice(0, 10) === bar.t.slice(0, 10)), range = today.slice(0, Math.max(1, Number(p.minutes || 15) / 5)); return p.operator === "above" ? bar.c > Math.max(...range.map((b) => b.h)) : bar.c < Math.min(...range.map((b) => b.l)); }
  return false;
}
async function alpaca(url: string, apiKey: string, apiSecret: string, init: RequestInit = {}) { const response = await fetch(url, { ...init, headers: { "APCA-API-KEY-ID": apiKey, "APCA-API-SECRET-KEY": apiSecret, "Content-Type": "application/json", ...(init.headers || {}) } }); const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.message || `Alpaca error ${response.status}`); return body; }

Deno.serve(async (request) => {
  if (request.headers.get("x-runner-secret") !== Deno.env.get("BG_RUNNER_SECRET")) return json({ error: "Unauthorized" }, 401);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const summary = { checked: 0, matched: 0, submitted: 0, skipped: 0, errors: 0, note: "Option execution remains fail-closed until multi-leg contract selection is enabled." };
  const { data: bots, error } = await admin.from("bg_bots").select("*").eq("status", "active").eq("environment", "paper").limit(100); if (error) return json({ error: error.message }, 500);
  const key = await cryptoKey();
  for (const bot of bots || []) {
    summary.checked++;
    try {
      if (bot.asset_class === "option") { summary.skipped++; continue; }
      const { data: connection } = await admin.from("bg_broker_connections").select("id").eq("user_id", bot.user_id).eq("environment", "paper").eq("status", "connected").maybeSingle(); if (!connection) { summary.skipped++; continue; }
      const { data: credential } = await admin.from("bg_broker_credentials").select("*").eq("connection_id", connection.id).single();
      const [apiKey, apiSecret] = await Promise.all([decrypt(credential.api_key_ciphertext, credential.api_key_iv, key), decrypt(credential.api_secret_ciphertext, credential.api_secret_iv, key)]);
      const clock = await alpaca("https://paper-api.alpaca.markets/v2/clock", apiKey, apiSecret); if (!clock.is_open) { summary.skipped++; continue; }
      const conditions = bot.start_condition?.conditions || []; const timeframe = conditions[0]?.timeframe || "5Min"; const start = new Date(Date.now() - 7 * 86400000).toISOString();
      const url = new URL(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(bot.symbol)}/bars`); url.searchParams.set("timeframe", timeframe); url.searchParams.set("start", start); url.searchParams.set("limit", "1000"); url.searchParams.set("feed", "iex");
      const bars: Bar[] = (await alpaca(url.toString(), apiKey, apiSecret)).bars || []; if (bars.length < 30) throw new Error("Not enough bars to evaluate conditions");
      const hit = conditions.length > 0 && (bot.start_condition?.operator === "OR" ? conditions.some((c: any) => matches(c, bars)) : conditions.every((c: any) => matches(c, bars))); if (!hit) { summary.skipped++; continue; } summary.matched++;
      const bucket = Math.floor(Date.now() / Math.max(Number(bot.cooldown_seconds || 300) * 1000, 300000)); const clientOrderId = `bg-${bot.id.slice(0, 12)}-${bucket}`;
      const existing = await fetch(`https://paper-api.alpaca.markets/v2/orders:by_client_order_id?client_order_id=${clientOrderId}`, { headers: { "APCA-API-KEY-ID": apiKey, "APCA-API-SECRET-KEY": apiSecret } }); if (existing.ok) { summary.skipped++; continue; }
      const { data: steps } = await admin.from("bg_averaging_steps").select("order_amount").eq("bot_id", bot.id).eq("step_number", 0).maybeSingle(); const notional = Math.min(Number(steps?.order_amount || bot.max_allocation), Number(bot.max_allocation));
      const order = await alpaca("https://paper-api.alpaca.markets/v2/orders", apiKey, apiSecret, { method: "POST", body: JSON.stringify({ symbol: bot.symbol, notional: notional.toFixed(2), side: bot.direction === "short" ? "sell" : "buy", type: "market", time_in_force: "day", client_order_id: clientOrderId }) });
      const { data: run } = await admin.from("bg_bot_runs").insert({ bot_id: bot.id, user_id: bot.user_id, status: "running", metadata: { worker: "paper-runner" } }).select("id").single();
      const { data: trade } = await admin.from("bg_trades").insert({ run_id: run.id, user_id: bot.user_id, symbol: bot.symbol, status: "pending", side: bot.direction, quantity: 0 }).select("id").single();
      await admin.from("bg_orders").insert({ trade_id: trade.id, user_id: bot.user_id, broker_order_id: order.id, client_order_id: clientOrderId, symbol: bot.symbol, side: bot.direction === "short" ? "sell" : "buy", order_type: "market", notional, status: order.status, raw_response: order, submitted_at: new Date().toISOString() });
      await admin.from("bg_bot_events").insert({ bot_id: bot.id, run_id: run.id, user_id: bot.user_id, event_type: "paper_order_submitted", message: `Submitted ${bot.symbol} paper order`, details: { broker_order_id: order.id, client_order_id: clientOrderId, notional } }); summary.submitted++;
    } catch (e) { summary.errors++; await admin.from("bg_bot_events").insert({ bot_id: bot.id, user_id: bot.user_id, event_type: "runner_error", severity: "error", message: e instanceof Error ? e.message : "Runner error" }); }
  }
  return json(summary);
});
