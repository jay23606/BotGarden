import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const b64 = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
async function decrypt(value: string, iv: string, key: CryptoKey) { return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(iv) }, key, b64(value))); }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const authorization = req.headers.get("Authorization");
    if (!authorization) return json({ error: "Authentication required" }, 401);
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { data: { user } } = await admin.auth.getUser(authorization.replace(/^Bearer\s+/i, ""));
    if (!user) return json({ error: "Invalid session" }, 401);
    const { orderId } = await req.json();
    if (!orderId) return json({ error: "Order ID is required" }, 400);
    const { data: connection } = await admin.from("bg_broker_connections").select("id").eq("user_id", user.id).eq("broker", "alpaca").eq("environment", "paper").eq("status", "connected").single();
    const { data: credentials } = await admin.from("bg_broker_credentials").select("*").eq("connection_id", connection.id).single();
    const raw = b64(Deno.env.get("BG_CREDENTIALS_KEY") || "");
    if (raw.length !== 32) throw new Error("Credential encryption is not configured");
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
    const [apiKey, secret] = await Promise.all([decrypt(credentials.api_key_ciphertext, credentials.api_key_iv, key), decrypt(credentials.api_secret_ciphertext, credentials.api_secret_iv, key)]);
    const headers = { "APCA-API-KEY-ID": apiKey, "APCA-API-SECRET-KEY": secret };
    const orderResponse = await fetch(`https://paper-api.alpaca.markets/v2/orders/${encodeURIComponent(orderId)}`, { headers });
    if (!orderResponse.ok) return json({ error: "Order was not found in this Alpaca paper account" }, 404);
    const order = await orderResponse.json();
    const cancelable = new Set(["new", "accepted", "pending_new", "partially_filled", "held", "calculated", "pending_replace", "accepted_for_bidding", "stopped"]);
    if (!cancelable.has(order.status)) return json({ error: `Order can no longer be canceled because it is ${order.status}` }, 409);
    const cancelResponse = await fetch(`https://paper-api.alpaca.markets/v2/orders/${encodeURIComponent(orderId)}`, { method: "DELETE", headers });
    if (!cancelResponse.ok) {
      const body = await cancelResponse.json().catch(() => ({}));
      return json({ error: body.message || `Alpaca cancellation failed (${cancelResponse.status})` }, cancelResponse.status === 422 ? 409 : 500);
    }
    const { data: localOrder } = await admin.from("bg_orders").select("id,trade_id").eq("user_id", user.id).eq("broker_order_id", orderId).maybeSingle();
    if (localOrder) {
      await admin.from("bg_orders").update({ status: "canceled" }).eq("id", localOrder.id);
      if (localOrder.trade_id) {
        const { data: trade } = await admin.from("bg_trades").select("run_id,status").eq("id", localOrder.trade_id).maybeSingle();
        if (trade?.status === "pending") await admin.from("bg_trades").update({ status: "cancelled" }).eq("id", localOrder.trade_id);
        if (trade?.run_id) {
          const { data: run } = await admin.from("bg_bot_runs").select("bot_id").eq("id", trade.run_id).maybeSingle();
          if (run?.bot_id) await admin.from("bg_bot_events").insert({ bot_id: run.bot_id, run_id: trade.run_id, user_id: user.id, event_type: "paper_order_canceled", message: `Canceled pending ${order.symbol || "multi-leg"} paper order`, details: { broker_order_id: orderId, previous_status: order.status } });
        }
      }
    }
    return json({ canceled: true, order_id: orderId });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to cancel order" }, 500);
  }
});
