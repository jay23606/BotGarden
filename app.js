import { configured, supabase, invoke, money, pct, escapeHtml } from "./core.js";

const $ = (s) => document.querySelector(s);
const authView = $("#auth-view");
const appView = $("#app-view");
const content = $("#page-content");
const modal = $("#modal");
let session = null;
let authMode = "signin";
let bots = [];

if (!configured) $("#setup-banner").classList.remove("hidden");

function setSession(next) {
  session = next;
  authView.classList.toggle("hidden", !!session);
  appView.classList.toggle("hidden", !session);
  if (session) loadDashboard();
}

async function boot() {
  if (!supabase) return;
  const { data } = await supabase.auth.getSession();
  setSession(data.session);
  supabase.auth.onAuthStateChange((_event, next) => setSession(next));
}

$("#auth-toggle").addEventListener("click", () => {
  authMode = authMode === "signin" ? "signup" : "signin";
  $("#auth-title").textContent = authMode === "signin" ? "Sign in to BotGarden" : "Create your account";
  $("#auth-subtitle").textContent = authMode === "signin" ? "Use your email and password to continue." : "Start with a free Alpaca paper account.";
  $("#auth-submit").textContent = authMode === "signin" ? "Sign in" : "Create account";
  $("#auth-toggle").textContent = authMode === "signin" ? "New here? Create an account" : "Already registered? Sign in";
  $("#auth-message").textContent = "";
});

$("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!supabase) return $("#auth-message").textContent = "Configure Supabase first.";
  const email = $("#email").value.trim();
  const password = $("#password").value;
  $("#auth-submit").disabled = true;
  const result = authMode === "signin"
    ? await supabase.auth.signInWithPassword({ email, password })
    : await supabase.auth.signUp({ email, password });
  $("#auth-submit").disabled = false;
  if (result.error) return $("#auth-message").textContent = result.error.message;
  if (authMode === "signup" && !result.data.session) $("#auth-message").textContent = "Check your email to confirm your account.";
});

$("#sign-out").addEventListener("click", () => supabase?.auth.signOut());
$("#new-bot").addEventListener("click", showBotForm);
document.addEventListener("click", (event) => {
  const nav = event.target.closest("[data-view]");
  if (nav) switchView(nav.dataset.view);
  if (event.target.closest("[data-new-bot]")) showBotForm();
  if (event.target.closest("[data-connect]")) showConnectionForm();
  if (event.target.closest("[data-close-modal]")) modal.close();
});

async function getConnection() {
  const { data } = await supabase.from("bg_broker_connections").select("id,broker,environment,account_number,status,last_verified_at").eq("broker", "alpaca").maybeSingle();
  return data;
}

async function loadDashboard() {
  const [{ data: botData }, connection] = await Promise.all([
    supabase.from("bg_bots").select("id,name,status,asset_class,symbol,direction,max_allocation,created_at").order("created_at", { ascending: false }),
    getConnection(),
  ]);
  bots = botData || [];
  const active = bots.filter((b) => b.status === "active").length;
  content.innerHTML = `
    <div class="cards">
      <div class="card metric"><span class="label">PAPER EQUITY</span><strong>—</strong><div class="subtle">Connect Alpaca to sync</div></div>
      <div class="card metric"><span class="label">ACTIVE BOTS</span><strong>${active}</strong><div class="subtle">${bots.length} configured</div></div>
      <div class="card metric"><span class="label">OPEN POSITIONS</span><strong>0</strong><div class="subtle">No open trades</div></div>
      <div class="card metric"><span class="label">TOTAL P&L</span><strong>${money(0)}</strong><div class="subtle">Paper performance</div></div>
    </div>
    <div class="section-head"><h3>Alpaca paper account</h3></div>
    <div class="card connection-card"><div class="connection-state"><div><span class="connection-dot ${connection?.status === "connected" ? "on" : ""}"></span><strong>${connection ? "Alpaca connected" : "Not connected"}</strong><div class="subtle">${connection ? `Paper account ${escapeHtml(connection.account_number || "")}` : "Add your own Alpaca paper API credentials."}</div></div><button class="secondary" data-connect>${connection ? "Reconnect" : "Connect account"}</button></div></div>
    <div class="section-head"><h3>Recent bots</h3></div>${renderBots()}`;
}

function renderBots() {
  if (!bots.length) return `<div class="empty"><h3>No bots yet</h3><div>Create a DCA bot and preview its complete averaging schedule.</div><button class="primary" data-new-bot>Create your first bot</button></div>`;
  return `<div class="bot-list">${bots.map((bot) => `<div class="bot-row"><div><div class="bot-name">${escapeHtml(bot.name)}</div><div class="subtle">${escapeHtml(bot.symbol)} · ${escapeHtml(bot.asset_class)}</div></div><div><span class="status">${escapeHtml(bot.status)}</span></div><div><div class="subtle">DIRECTION</div>${escapeHtml(bot.direction)}</div><div><div class="subtle">MAX ALLOCATION</div>${money(bot.max_allocation)}</div><button class="secondary">View</button></div>`).join("")}</div>`;
}

function switchView(view) {
  document.querySelectorAll(".nav-item[data-view]").forEach((el) => el.classList.toggle("active", el.dataset.view === view));
  $("#page-title").textContent = ({ dashboard: "Overview", bots: "Bots", activity: "Activity", settings: "Settings" })[view];
  if (view === "dashboard") return loadDashboard();
  if (view === "bots") return content.innerHTML = `<div class="section-head"><h3>All bots</h3></div>${renderBots()}`;
  if (view === "activity") return content.innerHTML = `<div class="empty"><h3>No activity yet</h3><div>Signals, bot decisions, orders, and fills will appear here.</div></div>`;
  content.innerHTML = `<div class="section-head"><h3>Broker connections</h3></div><div class="card connection-card"><p>Connect an Alpaca paper account using credentials created in your Alpaca dashboard.</p><button class="primary" data-connect>Connect Alpaca</button></div>`;
}

function showConnectionForm() {
  $("#modal-content").innerHTML = `<form id="connection-form"><div class="modal-head"><div><h3>Connect Alpaca</h3><p>Paper-trading credentials only for this release.</p></div><button type="button" class="icon-button" data-close-modal>×</button></div><div class="modal-body"><div class="callout">Your secret is sent directly to a protected Edge Function, encrypted server-side, and never returned to the browser.</div><div class="form-grid"><label class="span-2">API key ID<input name="apiKey" autocomplete="off" required></label><label class="span-2">Secret key<input name="apiSecret" type="password" autocomplete="new-password" required></label></div><p class="form-message" id="connection-message"></p></div><div class="modal-foot"><button type="button" class="secondary" data-close-modal>Cancel</button><button class="primary" type="submit">Verify and connect</button></div></form>`;
  modal.showModal();
  $("#connection-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.submitter; button.disabled = true;
    try {
      const form = new FormData(event.currentTarget);
      await invoke("alpaca-connection", { action: "connect", apiKey: form.get("apiKey"), apiSecret: form.get("apiSecret"), environment: "paper" });
      modal.close(); await loadDashboard();
    } catch (error) { $("#connection-message").textContent = error.message || "Could not connect the account."; button.disabled = false; }
  });
}

function scheduleFromForm(form) {
  const initial = Number(form.get("initialOrder"));
  const count = Number(form.get("stepCount"));
  const deviation = Number(form.get("deviation"));
  const stepScale = Number(form.get("stepScale"));
  const volumeScale = Number(form.get("volumeScale"));
  const steps = [{ step: 0, deviation: 0, amount: initial }];
  let cumulativeDeviation = 0;
  for (let i = 1; i <= count; i++) {
    cumulativeDeviation += deviation * Math.pow(stepScale, i - 1);
    steps.push({ step: i, deviation: cumulativeDeviation, amount: initial * Math.pow(volumeScale, i) });
  }
  let cumulative = 0;
  return steps.map((step) => ({ ...step, cumulative: cumulative += step.amount }));
}

function showBotForm() {
  $("#modal-content").innerHTML = `<form id="bot-form"><div class="modal-head"><div><h3>Create DCA bot</h3><p>Configure a paper-trading averaging strategy.</p></div><button type="button" class="icon-button" data-close-modal>×</button></div><div class="modal-body"><div class="form-grid">
    <label class="span-2">Bot name<input name="name" required placeholder="SPY pullback strategy"></label>
    <label>Asset class<select name="assetClass"><option value="equity">Stocks</option><option value="option">Stock options</option></select></label>
    <label>Symbol<input name="symbol" required value="SPY" maxlength="20"></label>
    <label>Direction<select name="direction"><option value="long">Long</option><option value="short">Short</option></select></label>
    <label>Start condition<select name="startType"><option value="immediate">Immediate</option><option value="price_below">Price below</option><option value="rsi_below">RSI below</option><option value="webhook">Webhook</option></select></label>
    <label>Initial order ($)<input name="initialOrder" type="number" min="1" step=".01" value="100" required></label>
    <label>Averaging orders<input name="stepCount" type="number" min="0" max="20" value="5" required></label>
    <label>Initial price deviation (%)<input name="deviation" type="number" min=".01" step=".01" value="2" required></label>
    <label>Step scale<input name="stepScale" type="number" min=".1" step=".1" value="1" required></label>
    <label>Order-volume scale<input name="volumeScale" type="number" min=".1" step=".1" value="1.5" required></label>
    <label>Take profit (%)<input name="takeProfit" type="number" min=".01" step=".01" value="2" required></label>
    <label>Stop loss (%)<input name="stopLoss" type="number" min="0" step=".01" value="20"></label>
  </div><div id="schedule-preview"></div><p class="form-message" id="bot-message"></p></div><div class="modal-foot"><button type="button" class="secondary" data-close-modal>Cancel</button><button class="primary" type="submit">Save draft bot</button></div></form>`;
  modal.showModal();
  const form = $("#bot-form");
  const preview = () => {
    const data = new FormData(form); const steps = scheduleFromForm(data);
    $("#schedule-preview").innerHTML = `<table class="schedule"><thead><tr><th>Order</th><th>Price deviation</th><th>Order size</th><th>Cumulative capital</th></tr></thead><tbody>${steps.map((s) => `<tr><td>${s.step ? `Averaging ${s.step}` : "Initial"}</td><td>-${pct(s.deviation)}</td><td>${money(s.amount)}</td><td>${money(s.cumulative)}</td></tr>`).join("")}</tbody></table><p class="danger-note">Maximum planned capital: ${money(steps.at(-1).cumulative)}. Averaging down can magnify losses in a sustained decline.</p>`;
  };
  form.addEventListener("input", preview); preview();
  form.addEventListener("submit", async (event) => {
    event.preventDefault(); const button = event.submitter; button.disabled = true;
    const data = new FormData(form); const schedule = scheduleFromForm(data);
    const payload = { user_id: session.user.id, name: data.get("name"), bot_type: "dca", status: "draft", broker: "alpaca", environment: "paper", asset_class: data.get("assetClass"), symbol: data.get("symbol").toUpperCase().trim(), direction: data.get("direction"), max_allocation: schedule.at(-1).cumulative, start_condition: { type: data.get("startType") }, take_profit_pct: Number(data.get("takeProfit")), stop_loss_pct: Number(data.get("stopLoss")) || null };
    const { data: bot, error } = await supabase.from("bg_bots").insert(payload).select().single();
    if (error) { $("#bot-message").textContent = error.message; button.disabled = false; return; }
    const rows = schedule.map((s) => ({ bot_id: bot.id, step_number: s.step, deviation_pct: s.deviation, order_amount: s.amount }));
    const { error: stepError } = await supabase.from("bg_averaging_steps").insert(rows);
    if (stepError) { $("#bot-message").textContent = stepError.message; button.disabled = false; return; }
    modal.close(); await loadDashboard();
  });
}

boot();
