import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, "Content-Type": "application/json" },
});

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  bytes.forEach((byte) => binary += String.fromCharCode(byte));
  return btoa(binary);
};

async function encryptionKey() {
  const encoded = Deno.env.get("BG_CREDENTIALS_KEY");
  if (!encoded) throw new Error("BG_CREDENTIALS_KEY is not configured");
  const raw = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  if (raw.length !== 32) throw new Error("BG_CREDENTIALS_KEY must be 32 bytes encoded as base64");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
}

async function encrypt(value: string, key: CryptoKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value));
  return { ciphertext: bytesToBase64(new Uint8Array(encrypted)), iv: bytesToBase64(iv) };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authorization = request.headers.get("Authorization");
    if (!authorization) return json({ error: "Authentication required" }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const token = authorization.replace(/^Bearer\s+/i, "");
    const { data: { user }, error: authError } = await admin.auth.getUser(token);
    if (authError || !user) return json({ error: "Invalid session" }, 401);

    const body = await request.json();
    if (body.action !== "connect") return json({ error: "Unsupported action" }, 400);
    const apiKey = String(body.apiKey || "").trim();
    const apiSecret = String(body.apiSecret || "").trim();
    if (!apiKey || !apiSecret) return json({ error: "API key and secret are required" }, 400);

    const alpacaResponse = await fetch("https://paper-api.alpaca.markets/v2/account", {
      headers: { "APCA-API-KEY-ID": apiKey, "APCA-API-SECRET-KEY": apiSecret },
    });
    if (!alpacaResponse.ok) return json({ error: "Alpaca rejected these paper credentials" }, 400);
    const account = await alpacaResponse.json();

    const { data: connection, error: connectionError } = await admin
      .from("bg_broker_connections")
      .upsert({
        user_id: user.id, broker: "alpaca", environment: "paper",
        account_number: account.account_number, status: "connected",
        last_verified_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }, { onConflict: "user_id,broker,environment" })
      .select("id").single();
    if (connectionError) throw connectionError;

    const key = await encryptionKey();
    const [encryptedKey, encryptedSecret] = await Promise.all([encrypt(apiKey, key), encrypt(apiSecret, key)]);
    const { error: credentialError } = await admin.from("bg_broker_credentials").upsert({
      connection_id: connection.id,
      api_key_ciphertext: encryptedKey.ciphertext,
      api_key_iv: encryptedKey.iv,
      api_secret_ciphertext: encryptedSecret.ciphertext,
      api_secret_iv: encryptedSecret.iv,
      encryption_version: 1,
      updated_at: new Date().toISOString(),
    });
    if (credentialError) throw credentialError;

    return json({ connected: true, accountNumber: account.account_number, status: account.status });
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "Unexpected error" }, 500);
  }
});
