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
    const [positionsResponse, accountResponse] = await Promise.all([
      fetch("https://paper-api.alpaca.markets/v2/positions", { headers }),
      fetch("https://paper-api.alpaca.markets/v2/account", { headers }),
    ]);
    if (!positionsResponse.ok) throw new Error(`Alpaca positions error (${positionsResponse.status})`);
    if (!accountResponse.ok) throw new Error(`Alpaca account error (${accountResponse.status})`);

    const rawPositions = await positionsResponse.json();
    const rawAccount = await accountResponse.json();
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
    return json({ connected: true, account, positions, as_of: new Date().toISOString() });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to load portfolio" }, 500);
  }
});
