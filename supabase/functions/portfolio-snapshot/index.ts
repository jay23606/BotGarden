import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...cors, "Content-Type": "application/json" },
});
const b64 = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

async function decrypt(value: string, iv: string, key: CryptoKey) {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(iv) }, key, b64(value));
  return new TextDecoder().decode(plain);
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
    if (!connection) return json({ positions: [], account: null, connected: false });
    const { data: credentials } = await admin.from("bg_broker_credentials").select("*").eq("connection_id", connection.id).single();
    const raw = b64(Deno.env.get("BG_CREDENTIALS_KEY") || "");
    if (raw.length !== 32) throw new Error("Credential encryption is not configured");
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
    const [apiKey, secret] = await Promise.all([
      decrypt(credentials.api_key_ciphertext, credentials.api_key_iv, key),
      decrypt(credentials.api_secret_ciphertext, credentials.api_secret_iv, key),
    ]);
    const headers = { "APCA-API-KEY-ID": apiKey, "APCA-API-SECRET-KEY": secret };
    const after = new Date(Date.now() - 30 * 86400000).toISOString();
    const [positionsResponse, accountResponse, historyResponse, activitiesResponse, ordersResponse] = await Promise.all([
      fetch("https://paper-api.alpaca.markets/v2/positions", { headers }),
      fetch("https://paper-api.alpaca.markets/v2/account", { headers }),
      fetch("https://paper-api.alpaca.markets/v2/account/portfolio/history?period=1M&timeframe=1D&intraday_reporting=market_hours&pnl_reset=per_day", { headers }),
      fetch("https://paper-api.alpaca.markets/v2/account/activities/FILL?direction=desc&page_size=100", { headers }),
      fetch(`https://paper-api.alpaca.markets/v2/orders?status=all&direction=desc&limit=500&after=${encodeURIComponent(after)}`, { headers }),
    ]);
    if (!positionsResponse.ok) throw new Error(`Alpaca positions error (${positionsResponse.status})`);
    if (!accountResponse.ok) throw new Error(`Alpaca account error (${accountResponse.status})`);

    const rawPositions = await positionsResponse.json();
    const rawAccount = await accountResponse.json();
    const rawHistory = historyResponse.ok ? await historyResponse.json() : {};
    const rawActivities = activitiesResponse.ok ? await activitiesResponse.json() : [];
    const rawOrders = ordersResponse.ok ? await ordersResponse.json() : [];
    const positions = rawPositions.map((position: any) => ({
      symbol: position.symbol,
      asset_class: position.asset_class === "crypto" ? "crypto" : position.asset_class === "us_option" ? "option" : "equity",
      side: position.side,
      qty: Number(position.qty),
      avg_entry_price: Number(position.avg_entry_price),
      current_price: Number(position.current_price),
      market_value: Number(position.market_value),
      cost_basis: Number(position.cost_basis),
      unrealized_pl: Number(position.unrealized_pl),
      unrealized_plpc: Number(position.unrealized_plpc) * 100,
      change_today: Number(position.change_today) * 100,
    }));
    const account = {
      status: rawAccount.status,
      equity: Number(rawAccount.equity),
      portfolio_value: Number(rawAccount.portfolio_value),
      last_equity: Number(rawAccount.last_equity),
      cash: Number(rawAccount.cash),
      buying_power: Number(rawAccount.buying_power),
      long_market_value: Number(rawAccount.long_market_value),
      short_market_value: Number(rawAccount.short_market_value),
      accrued_fees: Number(rawAccount.accrued_fees || 0),
    };
    const timestamps = rawHistory.timestamp || [], equities = rawHistory.equity || [], pnl = rawHistory.profit_loss || [], pnlPct = rawHistory.profit_loss_pct || [];
    const history = timestamps.map((timestamp: number, index: number) => ({
      timestamp,
      equity: Number(equities[index] || 0),
      profit_loss: Number(pnl[index] || 0),
      profit_loss_pct: Number(pnlPct[index] || 0) * 100,
    })).filter((point: any) => point.equity > 0);
    const fills = rawActivities.map((fill: any) => ({
      activity_id: fill.id,
      order_id: fill.order_id,
      symbol: fill.symbol,
      side: fill.side,
      quantity: Number(fill.qty),
      cumulative_quantity: Number(fill.cum_qty),
      price: Number(fill.price),
      transaction_time: fill.transaction_time,
    }));
    let reconciledOrders = 0;
    const brokerOrderIds = rawOrders.map((order: any) => order.id).filter(Boolean);
    if (brokerOrderIds.length) {
      const { data: localOrders } = await admin.from("bg_orders").select("id,trade_id,broker_order_id,status").eq("user_id", user.id).in("broker_order_id", brokerOrderIds);
      const brokerOrders = new Map(rawOrders.map((order: any) => [order.id, order]));
      for (const localOrder of localOrders || []) {
        const brokerOrder: any = brokerOrders.get(localOrder.broker_order_id);
        if (!brokerOrder) continue;
        if (localOrder.status !== brokerOrder.status) {
          await admin.from("bg_orders").update({ status: brokerOrder.status, raw_response: brokerOrder }).eq("id", localOrder.id);
          reconciledOrders++;
        }
        if (localOrder.trade_id && brokerOrder.status === "filled") {
          const { data: trade } = await admin.from("bg_trades").select("status").eq("id", localOrder.trade_id).maybeSingle();
          if (trade?.status === "pending") await admin.from("bg_trades").update({ status: "open", quantity: Number(brokerOrder.filled_qty || 0), average_entry: Number(brokerOrder.filled_avg_price || 0), opened_at: brokerOrder.filled_at || new Date().toISOString() }).eq("id", localOrder.trade_id);
          else if (trade?.status === "closing") await admin.from("bg_trades").update({ status: "closed", closed_at: brokerOrder.filled_at || new Date().toISOString() }).eq("id", localOrder.trade_id);
        }
      }
    }
    return json({ connected: true, account, positions, history, fills, reconciled_orders: reconciledOrders, as_of: new Date().toISOString() });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to load portfolio" }, 500);
  }
});
