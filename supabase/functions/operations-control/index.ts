import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const fromB64 = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
async function cryptoKey() { const raw = fromB64(Deno.env.get("BG_CREDENTIALS_KEY") || ""); if (raw.length !== 32) throw new Error("Credential encryption is not configured"); return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]); }
async function decrypt(value: string, iv: string, key: CryptoKey) { return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv) }, key, fromB64(value))); }

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const authorization = request.headers.get("Authorization"); if (!authorization) return json({ error: "Authentication required" }, 401);
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { data: { user } } = await admin.auth.getUser(authorization.replace(/^Bearer\s+/i, "")); if (!user) return json({ error: "Invalid session" }, 401);
    const body = await request.json().catch(() => ({})), action = String(body.action || "status");
    if (action === "status") { const [{ data: control }, { data: health }, { data: workerRuns }, { data: reconciliationIssues }] = await Promise.all([admin.from("bg_user_controls").select("*").eq("user_id", user.id).maybeSingle(), admin.from("bg_worker_heartbeats").select("*").order("worker_mode"), admin.from("bg_worker_runs").select("id,worker_mode,started_at,completed_at,duration_ms,status,checked_count,submitted_count,exit_count,error_count").order("started_at", { ascending: false }).limit(12), admin.from("bg_reconciliation_issues").select("id,issue_key,symbol,asset_class,classification,severity,status,details,first_seen_at,last_seen_at").eq("user_id", user.id).eq("status", "open").order("last_seen_at", { ascending: false }).limit(20)]); return json({ entries_paused: !!control?.entries_paused, paused_at: control?.paused_at || null, health: health || [], worker_runs: workerRuns || [], reconciliation_issues: reconciliationIssues || [] }); }
    if (!["pause", "resume"].includes(action)) return json({ error: "Unsupported action" }, 400);
    const paused = action === "pause"; await admin.from("bg_user_controls").upsert({ user_id: user.id, entries_paused: paused, paused_at: paused ? new Date().toISOString() : null, updated_at: new Date().toISOString() });
    let canceled = 0, cancelErrors = 0;
    if (paused && body.cancelPending === true) {
      const { data: connection } = await admin.from("bg_broker_connections").select("id").eq("user_id", user.id).eq("broker", "alpaca").eq("environment", "paper").eq("status", "connected").maybeSingle();
      if (connection) { const { data: credential } = await admin.from("bg_broker_credentials").select("*").eq("connection_id", connection.id).single(), key = await cryptoKey(), [apiKey, apiSecret] = await Promise.all([decrypt(credential.api_key_ciphertext, credential.api_key_iv, key), decrypt(credential.api_secret_ciphertext, credential.api_secret_iv, key)]), { data: tracked } = await admin.from("bg_orders").select("broker_order_id").eq("user_id", user.id).not("broker_order_id", "is", null).limit(5000), trackedIds = new Set((tracked || []).map((order: any) => order.broker_order_id)), openResponse = await fetch("https://paper-api.alpaca.markets/v2/orders?status=open&limit=500", { headers: { "APCA-API-KEY-ID": apiKey, "APCA-API-SECRET-KEY": apiSecret } }), openOrders = openResponse.ok ? await openResponse.json() : [];
        for (const order of openOrders.filter((item: any) => trackedIds.has(item.id))) { const response = await fetch(`https://paper-api.alpaca.markets/v2/orders/${order.id}`, { method: "DELETE", headers: { "APCA-API-KEY-ID": apiKey, "APCA-API-SECRET-KEY": apiSecret } }); if (response.ok || response.status === 404) canceled++; else cancelErrors++; }
      }
    }
    return json({ entries_paused: paused, paused_at: paused ? new Date().toISOString() : null, canceled_pending_orders: canceled, cancel_errors: cancelErrors });
  } catch (error) { return json({ error: error instanceof Error ? error.message : "Operational control failed" }, 500); }
});
