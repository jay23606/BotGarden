import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const b64 = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
const symbolKey = (value: unknown) => String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
async function decrypt(value: string, iv: string, key: CryptoKey) { return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(iv) }, key, b64(value))); }
async function alpaca(url: string, apiKey: string, secret: string) {
  const response = await fetch(url, { headers: { "APCA-API-KEY-ID": apiKey, "APCA-API-SECRET-KEY": secret } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `Alpaca error (${response.status})`);
  return body;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const authorization = req.headers.get("Authorization");
    if (!authorization) return json({ error: "Authentication required" }, 401);
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { data: { user } } = await admin.auth.getUser(authorization.replace(/^Bearer\s+/i, ""));
    if (!user) return json({ error: "Invalid session" }, 401);
    const { data: connection } = await admin.from("bg_broker_connections").select("id").eq("user_id", user.id).eq("broker", "alpaca").eq("environment", "paper").eq("status", "connected").maybeSingle();
    if (!connection) return json({ connected: false, bots: [], unattributed_fill_count: 0 });
    const { data: credentials } = await admin.from("bg_broker_credentials").select("*").eq("connection_id", connection.id).single();
    const raw = b64(Deno.env.get("BG_CREDENTIALS_KEY") || "");
    if (raw.length !== 32) throw new Error("Credential encryption is not configured");
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
    const [apiKey, secret] = await Promise.all([decrypt(credentials.api_key_ciphertext, credentials.api_key_iv, key), decrypt(credentials.api_secret_ciphertext, credentials.api_secret_iv, key)]);

    const [{ data: bots }, { data: orders }, { data: trades }, { data: runs }, { data: events }, positions] = await Promise.all([
      admin.from("bg_bots").select("id,name,symbol,asset_class,max_allocation").eq("user_id", user.id),
      admin.from("bg_orders").select("broker_order_id,trade_id").eq("user_id", user.id).not("broker_order_id", "is", null).limit(10000),
      admin.from("bg_trades").select("id,run_id").eq("user_id", user.id).limit(10000),
      admin.from("bg_bot_runs").select("id,bot_id").eq("user_id", user.id).limit(10000),
      admin.from("bg_bot_events").select("bot_id,details").eq("user_id", user.id).order("created_at", { ascending: false }).limit(10000),
      alpaca("https://paper-api.alpaca.markets/v2/positions", apiKey, secret),
    ]);
    const botIds = new Set((bots || []).map((bot: any) => bot.id));
    const runBot = new Map((runs || []).map((run: any) => [run.id, run.bot_id]));
    const tradeBot = new Map((trades || []).map((trade: any) => [trade.id, runBot.get(trade.run_id)]));
    const orderBot = new Map<string, string>();
    for (const order of orders || []) { const botId = tradeBot.get(order.trade_id); if (botId && botIds.has(botId)) orderBot.set(order.broker_order_id, botId); }
    for (const event of events || []) { const orderId = event.details?.broker_order_id; if (orderId && botIds.has(event.bot_id) && !orderBot.has(orderId)) orderBot.set(orderId, event.bot_id); }

    const fills: any[] = [];
    let pageToken = "", truncated = false;
    for (let page = 0; page < 10; page++) {
      const url = new URL("https://paper-api.alpaca.markets/v2/account/activities/FILL");
      url.searchParams.set("direction", "desc"); url.searchParams.set("page_size", "100");
      if (pageToken) url.searchParams.set("page_token", pageToken);
      const batch = await alpaca(url.toString(), apiKey, secret);
      if (!Array.isArray(batch) || !batch.length) break;
      fills.push(...batch);
      if (batch.length < 100) break;
      pageToken = batch.at(-1)?.id;
      if (page === 9) truncated = true;
    }
    fills.sort((a, b) => new Date(a.transaction_time).valueOf() - new Date(b.transaction_time).valueOf());
    const marks = new Map<string, number>();
    for (const position of positions || []) marks.set(symbolKey(position.symbol), Number(position.current_price));
    const state = new Map<string, any>(), globalLots = new Map<string, any[]>();
    for (const bot of bots || []) state.set(bot.id, { bot_id: bot.id, fill_count: 0, realized_pnl: 0, unrealized_pnl: 0, total_pnl: 0, open_cost: 0, closed_quantity: 0, mark_to_market_complete: true, first_fill_at: null, last_fill_at: null });
    let unattributed = 0;
    for (const fill of fills) {
      const botId = orderBot.get(fill.order_id), symbol = symbolKey(fill.symbol), price = Number(fill.price), absoluteQty = Number(fill.qty), signedQty = fill.side === "buy" ? absoluteQty : -absoluteQty;
      if (!Number.isFinite(price) || !Number.isFinite(signedQty) || !signedQty) continue;
      const lots = globalLots.get(symbol) || []; let remaining = signedQty; const touched = new Set<string>();
      while (remaining && lots.length && Math.sign(lots[0].qty) !== Math.sign(remaining)) {
        const lot = lots[0], matched = Math.min(Math.abs(remaining), Math.abs(lot.qty));
        const performance = state.get(lot.bot_id);
        performance.realized_pnl += lot.qty > 0 ? (price - lot.price) * matched : (lot.price - price) * matched;
        performance.closed_quantity += matched; performance.first_fill_at ||= fill.transaction_time; performance.last_fill_at = fill.transaction_time; touched.add(lot.bot_id);
        lot.qty += Math.sign(remaining) * matched; remaining -= Math.sign(remaining) * matched;
        if (Math.abs(lot.qty) < 1e-10) lots.shift();
      }
      if (Math.abs(remaining) >= 1e-10) {
        if (!botId || !state.has(botId)) unattributed++;
        else { lots.push({ bot_id: botId, qty: remaining, price }); const performance = state.get(botId); performance.first_fill_at ||= fill.transaction_time; performance.last_fill_at = fill.transaction_time; touched.add(botId); }
      }
      for (const touchedBotId of touched) state.get(touchedBotId).fill_count++;
      globalLots.set(symbol, lots);
    }
    for (const [symbol, lots] of globalLots) {
      const mark = marks.get(symbol);
      for (const lot of lots) {
        const performance = state.get(lot.bot_id); performance.open_cost += Math.abs(lot.qty * lot.price);
        if (!mark) performance.mark_to_market_complete = false;
        else performance.unrealized_pnl += lot.qty > 0 ? (mark - lot.price) * lot.qty : (lot.price - mark) * Math.abs(lot.qty);
      }
    }
    for (const performance of state.values()) {
      performance.total_pnl = performance.realized_pnl + performance.unrealized_pnl;
      performance.return_on_open_cost_pct = performance.open_cost ? performance.total_pnl / performance.open_cost * 100 : null;
    }
    const positionAttribution = (positions || []).map((position: any) => {
      const brokerQty = (position.side === "short" ? -1 : 1) * Math.abs(Number(position.qty || 0));
      const lots = globalLots.get(symbolKey(position.symbol)) || [];
      const attributedQty = lots.reduce((sum: number, lot: any) => sum + Number(lot.qty || 0), 0);
      const unmanagedQty = brokerQty - attributedQty, tolerance = 1e-8;
      const classification = Math.abs(attributedQty) < tolerance ? "unmanaged" : Math.abs(unmanagedQty) < tolerance ? "managed" : "mixed";
      return { symbol: position.symbol, asset_class: position.asset_class === "crypto" ? "crypto" : position.asset_class === "us_option" ? "option" : "equity", broker_quantity: brokerQty, attributed_quantity: attributedQty, unmanaged_quantity: unmanagedQty, classification, confidence: truncated ? "estimated" : "verified" };
    });
    return json({ connected: true, bots: [...state.values()], position_attribution: positionAttribution, unattributed_fill_count: unattributed, activity_count: fills.length, truncated, as_of: new Date().toISOString() });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to calculate bot performance" }, 500);
  }
});
