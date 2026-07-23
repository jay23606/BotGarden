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
    if (!connection) return json({ connected: false, bots: [], recent_realized: [], unattributed_fill_count: 0 });
    const { data: credentials } = await admin.from("bg_broker_credentials").select("*").eq("connection_id", connection.id).single();
    const raw = b64(Deno.env.get("BG_CREDENTIALS_KEY") || "");
    if (raw.length !== 32) throw new Error("Credential encryption is not configured");
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
    const [apiKey, secret] = await Promise.all([decrypt(credentials.api_key_ciphertext, credentials.api_key_iv, key), decrypt(credentials.api_secret_ciphertext, credentials.api_secret_iv, key)]);

    const [{ data: bots }, { data: orders }, { data: trades }, { data: runs }, { data: events }, positions] = await Promise.all([
      admin.from("bg_bots").select("id,name,symbol,asset_class,max_allocation").eq("user_id", user.id),
      admin.from("bg_orders").select("broker_order_id,bot_id,trade_id").eq("user_id", user.id).not("broker_order_id", "is", null).limit(10000),
      admin.from("bg_trades").select("id,run_id").eq("user_id", user.id).limit(10000),
      admin.from("bg_bot_runs").select("id,bot_id").eq("user_id", user.id).limit(10000),
      admin.from("bg_bot_events").select("bot_id,details").eq("user_id", user.id).order("created_at", { ascending: false }).limit(10000),
      alpaca("https://paper-api.alpaca.markets/v2/positions", apiKey, secret),
    ]);
    const botIds = new Set((bots || []).map((bot: any) => bot.id));
    const runBot = new Map((runs || []).map((run: any) => [run.id, run.bot_id]));
    const tradeBot = new Map((trades || []).map((trade: any) => [trade.id, runBot.get(trade.run_id)]));
    const orderBot = new Map<string, string>();
    for (const order of orders || []) { const botId = order.bot_id || tradeBot.get(order.trade_id); if (botId && botIds.has(botId)) orderBot.set(order.broker_order_id, botId); }
    for (const event of events || []) { const orderId = event.details?.broker_order_id; if (orderId && botIds.has(event.bot_id) && !orderBot.has(orderId)) orderBot.set(orderId, event.bot_id); }

    let fills: any[] = [];
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
    if (fills.length) {
      const rows = fills.map((fill: any) => ({ user_id: user.id, activity_id: fill.id, broker_order_id: fill.order_id, bot_id: orderBot.get(fill.order_id) || null, symbol: symbolKey(fill.symbol), side: fill.side, quantity: Number(fill.qty), price: Number(fill.price), transaction_time: fill.transaction_time, raw_activity: fill })), attributed = rows.filter((row: any) => row.bot_id), unattributedRows = rows.filter((row: any) => !row.bot_id);
      if (attributed.length) await admin.from("bg_fill_ledger").upsert(attributed, { onConflict: "user_id,activity_id" });
      if (unattributedRows.length) await admin.from("bg_fill_ledger").upsert(unattributedRows, { onConflict: "user_id,activity_id", ignoreDuplicates: true });
    }
    const { data: ledger } = await admin.from("bg_fill_ledger").select("activity_id,broker_order_id,bot_id,symbol,side,quantity,price,transaction_time").eq("user_id", user.id).order("transaction_time", { ascending: true }).limit(50000);
    if (ledger?.length) {
      fills = ledger.map((fill: any) => ({ id: fill.activity_id, order_id: fill.broker_order_id, symbol: fill.symbol, side: fill.side, qty: fill.quantity, price: fill.price, transaction_time: fill.transaction_time, ledger_bot_id: fill.bot_id }));
    }
    const marks = new Map<string, number>();
    for (const position of positions || []) marks.set(symbolKey(position.symbol), Number(position.current_price));
    const state = new Map<string, any>(), globalLots = new Map<string, any[]>(), realizedClosures = new Map<string, any>(), botNames = new Map((bots || []).map((bot:any)=>[bot.id,bot.name]));
    for (const bot of bots || []) state.set(bot.id, { bot_id: bot.id, fill_count: 0, realized_pnl: 0, unrealized_pnl: 0, total_pnl: 0, open_cost: 0, closed_quantity: 0, mark_to_market_complete: true, first_fill_at: null, last_fill_at: null });
    let unattributed = 0;
    for (const fill of fills) {
      const botId = fill.ledger_bot_id || orderBot.get(fill.order_id), symbol = symbolKey(fill.symbol), price = Number(fill.price), absoluteQty = Number(fill.qty), signedQty = fill.side === "buy" ? absoluteQty : -absoluteQty;
      if (!Number.isFinite(price) || !Number.isFinite(signedQty) || !signedQty) continue;
      if (!botId || !state.has(botId)) { unattributed++; continue; }
      const lots = globalLots.get(symbol) || []; let remaining = signedQty; const touched = new Set<string>();
      while (Math.abs(remaining) >= 1e-10 && lots.length) {
        const matchIndex = lots.findIndex((lot: any) => Math.sign(lot.qty) !== Math.sign(remaining) && lot.bot_id === botId);
        if (matchIndex < 0) break;
        const lot = lots[matchIndex], matched = Math.min(Math.abs(remaining), Math.abs(lot.qty));
        const performance = state.get(lot.bot_id);
        if (performance) { const realized=lot.qty > 0 ? (price - lot.price) * matched : (lot.price - price) * matched,key=`${lot.bot_id}:${fill.order_id||fill.id}`,closure=realizedClosures.get(key)||{bot_id:lot.bot_id,bot_name:botNames.get(lot.bot_id)||"Bot",broker_order_id:fill.order_id||null,symbols:new Set<string>(),quantity:0,entry_value:0,exit_value:0,realized_pnl:0,closed_at:fill.transaction_time};performance.realized_pnl+=realized;performance.closed_quantity+=matched;performance.first_fill_at||=fill.transaction_time;performance.last_fill_at=fill.transaction_time;touched.add(lot.bot_id);closure.symbols.add(symbol);closure.quantity+=matched;closure.entry_value+=lot.price*matched;closure.exit_value+=price*matched;closure.realized_pnl+=realized;if(fill.transaction_time>closure.closed_at)closure.closed_at=fill.transaction_time;realizedClosures.set(key,closure); }
        lot.qty += Math.sign(remaining) * matched; remaining -= Math.sign(remaining) * matched;
        if (Math.abs(lot.qty) < 1e-10) lots.splice(matchIndex, 1);
      }
      if (Math.abs(remaining) >= 1e-10) {
        lots.push({ bot_id: botId, qty: remaining, price }); const performance = state.get(botId); performance.first_fill_at ||= fill.transaction_time; performance.last_fill_at = fill.transaction_time; touched.add(botId);
      }
      for (const touchedBotId of touched) state.get(touchedBotId).fill_count++;
      globalLots.set(symbol, lots);
    }
    for (const [symbol, lots] of globalLots) {
      const mark = marks.get(symbol);
      for (const lot of lots) {
        const performance = state.get(lot.bot_id); if (!performance) continue; performance.open_cost += Math.abs(lot.qty * lot.price);
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
      const botQuantities = lots.reduce((result: Record<string, number>, lot: any) => { result[lot.bot_id] = (result[lot.bot_id] || 0) + Number(lot.qty || 0); return result; }, {});
      return { symbol: position.symbol, asset_class: position.asset_class === "crypto" ? "crypto" : position.asset_class === "us_option" ? "option" : "equity", broker_quantity: brokerQty, attributed_quantity: attributedQty, unmanaged_quantity: unmanagedQty, bot_quantities: botQuantities, classification, confidence: truncated && !ledger?.length ? "estimated" : "verified" };
    });
    const now = new Date().toISOString(), activeKeys: string[] = [], issueRows = positionAttribution.filter((item: any) => item.classification !== "managed").map((item: any) => { const issueKey = `position:${symbolKey(item.symbol)}`; activeKeys.push(issueKey); return { user_id: user.id, issue_key: issueKey, symbol: item.symbol, asset_class: item.asset_class, classification: item.classification, severity: item.classification === "mixed" ? "error" : "warning", status: "open", details: { broker_quantity: item.broker_quantity, attributed_quantity: item.attributed_quantity, unmanaged_quantity: item.unmanaged_quantity, confidence: item.confidence }, last_seen_at: now, resolved_at: null }; });
    if (unattributed > 0) { activeKeys.push("fills:unattributed"); issueRows.push({ user_id: user.id, issue_key: "fills:unattributed", symbol: null, asset_class: null, classification: "unattributed_fill", severity: "error", status: "open", details: { count: unattributed }, last_seen_at: now, resolved_at: null }); }
    if (issueRows.length) await admin.from("bg_reconciliation_issues").upsert(issueRows, { onConflict: "user_id,issue_key" });
    let resolvedQuery = admin.from("bg_reconciliation_issues").update({ status: "resolved", resolved_at: now }).eq("user_id", user.id).eq("status", "open"); if (activeKeys.length) resolvedQuery = resolvedQuery.not("issue_key", "in", `(${activeKeys.map((key) => `"${key}"`).join(",")})`); await resolvedQuery;
    const recentRealized=[...realizedClosures.values()].map((closure:any)=>({bot_id:closure.bot_id,bot_name:closure.bot_name,broker_order_id:closure.broker_order_id,symbols:[...closure.symbols],quantity:closure.quantity,average_entry:closure.quantity?closure.entry_value/closure.quantity:null,average_exit:closure.quantity?closure.exit_value/closure.quantity:null,realized_pnl:closure.realized_pnl,closed_at:closure.closed_at})).sort((a:any,b:any)=>new Date(b.closed_at).valueOf()-new Date(a.closed_at).valueOf()).slice(0,50);
    return json({ connected: true, bots: [...state.values()], recent_realized:recentRealized, position_attribution: positionAttribution, unattributed_fill_count: unattributed, activity_count: fills.length, truncated, as_of: new Date().toISOString() });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to calculate bot performance" }, 500);
  }
});
