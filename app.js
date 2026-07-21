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
$("#random-bot").addEventListener("click", showRandomBotForm);
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

const CONDITION_CATALOG = [
  ["immediate", "Immediate", []],
  ["price", "Price threshold", [["operator", "Direction", "select", "below:Crosses below|above:Crosses above"], ["value", "Price ($)", "number", "100"]]],
  ["percent_change", "Percent change", [["anchor", "Measured from", "select", "previous_close:Previous close|session_open:Session open|rolling:Rolling window"], ["operator", "Direction", "select", "below:Falls by|above:Rises by"], ["value", "Change (%)", "number", "2"]]],
  ["gap", "Opening gap", [["operator", "Direction", "select", "down:Gap down|up:Gap up"], ["value", "Minimum gap (%)", "number", "2"]]],
  ["session_breakout", "Session high / low breakout", [["operator", "Break", "select", "above:Above session high|below:Below session low"], ["buffer", "Buffer (%)", "number", "0"]]],
  ["opening_range", "Opening-range breakout", [["minutes", "Opening range", "select", "5:5 minutes|15:15 minutes|30:30 minutes|60:60 minutes"], ["operator", "Break", "select", "above:Above range|below:Below range"]]],
  ["volume", "Volume threshold", [["operator", "Direction", "select", "above:Above|below:Below"], ["value", "Shares", "number", "100000"]]],
  ["relative_volume", "Relative volume", [["operator", "Direction", "select", "above:Above|below:Below"], ["value", "Multiple", "number", "2"], ["lookback", "Average lookback", "number", "20"]]],
  ["vwap", "VWAP cross", [["operator", "Direction", "select", "above:Crosses above|below:Crosses below"]]],
  ["moving_average", "Moving-average cross", [["average", "Average type", "select", "ema:EMA|sma:SMA"], ["fast", "Fast period", "number", "9"], ["slow", "Slow period", "number", "21"], ["operator", "Direction", "select", "above:Fast crosses above|below:Fast crosses below"]]],
  ["rsi", "RSI", [["period", "Period", "number", "14"], ["operator", "Direction", "select", "below:Below|above:Above"], ["value", "RSI level", "number", "30"]]],
  ["macd", "MACD crossover", [["fast", "Fast period", "number", "12"], ["slow", "Slow period", "number", "26"], ["signal", "Signal period", "number", "9"], ["operator", "Direction", "select", "bullish:Bullish cross|bearish:Bearish cross"]]],
  ["bollinger", "Bollinger Band", [["period", "Period", "number", "20"], ["deviations", "Std. deviations", "number", "2"], ["operator", "Event", "select", "below_lower:Below lower band|above_lower:Back above lower band|above_upper:Above upper band|below_upper:Back below upper band"]]],
  ["atr", "ATR volatility", [["period", "Period", "number", "14"], ["operator", "Direction", "select", "above:Above|below:Below"], ["value", "ATR (%)", "number", "2"]]],
  ["candles", "Consecutive candles", [["color", "Candle direction", "select", "green:Green|red:Red"], ["count", "Number of candles", "number", "3"]]],
  ["time_window", "Time window", [["start", "Start (ET)", "time", "09:30"], ["end", "End (ET)", "time", "15:45"]]],
  ["weekday", "Day of week", [["days", "Allowed days", "text", "Mon,Tue,Wed,Thu,Fri"]]],
  ["news", "Symbol news", [["keyword", "Headline keyword (optional)", "text", ""], ["minutes", "Published within minutes", "number", "15"]]],
  ["bid_ask_spread", "Bid/ask spread", [["operator", "Direction", "select", "below:Below|above:Above"], ["value", "Spread (%)", "number", "0.25"]]],
  ["buying_power", "Available buying power", [["operator", "Direction", "select", "above:Above|below:Below"], ["value", "Amount ($)", "number", "1000"]]],
  ["daily_pnl", "Daily account P&L", [["operator", "Direction", "select", "above:Above|below:Below"], ["value", "P&L ($)", "number", "-100"]]],
  ["open_positions", "Open-position count", [["operator", "Direction", "select", "below:Below|above:Above"], ["value", "Positions", "number", "3"]]],
  ["option_delta", "Option delta", [["operator", "Direction", "select", "above:Above|below:Below"], ["value", "Delta", "number", "0.3"]]],
  ["option_iv", "Option implied volatility", [["operator", "Direction", "select", "above:Above|below:Below"], ["value", "IV (%)", "number", "30"]]],
  ["option_dte", "Option days to expiration", [["operator", "Direction", "select", "above:At least|below:At most"], ["value", "Days", "number", "30"]]],
  ["webhook", "External webhook", [["signal", "Signal name", "text", "entry"]]],
];

const conditionDefinition = (type) => CONDITION_CATALOG.find(([id]) => id === type) || CONDITION_CATALOG[0];
const conditionOptions = () => CONDITION_CATALOG.map(([id, label]) => `<option value="${id}">${label}</option>`).join("");

function paramControl(index, [key, label, kind, choices]) {
  const name = `condition_${index}_${key}`;
  if (kind === "select") return `<label>${label}<select name="${name}">${choices.split("|").map((choice) => { const [value, text] = choice.split(":"); return `<option value="${value}">${text}</option>`; }).join("")}</select></label>`;
  const step = kind === "number" ? ' step="any"' : "";
  const required = choices === "" ? "" : " required";
  return `<label>${label}<input name="${name}" type="${kind}" value="${choices}"${step}${required}></label>`;
}

function renderConditionRow(index, type = "immediate") {
  const [, , params] = conditionDefinition(type);
  return `<div class="condition-row" data-condition-index="${index}"><div class="condition-top"><strong>Condition ${index + 1}</strong>${index ? '<button class="text-button remove-condition" type="button">Remove</button>' : ""}</div><div class="condition-grid"><label>Condition<select name="condition_${index}_type" class="condition-type">${conditionOptions()}</select></label><label>Timeframe<select name="condition_${index}_timeframe"><option value="1Min">1 minute</option><option value="5Min" selected>5 minutes</option><option value="15Min">15 minutes</option><option value="1Hour">1 hour</option><option value="1Day">1 day</option></select></label><div class="condition-params">${params.map((param) => paramControl(index, param)).join("")}</div></div></div>`;
}

function readConditions(form) {
  const data = new FormData(form);
  const conditions = [...form.querySelectorAll(".condition-row")].map((row, index) => {
    const type = data.get(`condition_${index}_type`);
    const [, , params] = conditionDefinition(type);
    return { type, timeframe: data.get(`condition_${index}_timeframe`), parameters: Object.fromEntries(params.map(([key, , kind]) => {
      const value = data.get(`condition_${index}_${key}`);
      return [key, kind === "number" ? Number(value) : value];
    })) };
  });
  return { operator: conditions.length > 1 ? data.get("conditionOperator") : "AND", conditions };
}

const RANDOM_STRATEGIES = [
  {
    id: "rsi_vwap", name: "RSI + VWAP Reversion", posture: ["conservative", "balanced"], horizon: ["intraday", "swing"],
    description: "Waits for an oversold reading and price below VWAP before averaging into a potential rebound.",
    conditions: [
      { type: "rsi", timeframe: "5Min", parameters: { period: 14, operator: "below", value: 30 } },
      { type: "vwap", timeframe: "5Min", parameters: { operator: "below" } },
    ], steps: 3, deviation: 2, stepScale: 1.15, volumeScale: 1.2, takeProfit: 2, stopLoss: 10,
  },
  {
    id: "trend_pullback", name: "Trend Pullback", posture: ["conservative", "balanced"], horizon: ["intraday", "swing"],
    description: "Requires a bullish moving-average structure while RSI shows a controlled pullback.",
    conditions: [
      { type: "moving_average", timeframe: "15Min", parameters: { average: "ema", fast: 9, slow: 21, operator: "above" } },
      { type: "rsi", timeframe: "15Min", parameters: { period: 14, operator: "below", value: 45 } },
    ], steps: 3, deviation: 2.5, stepScale: 1.1, volumeScale: 1.15, takeProfit: 3, stopLoss: 12,
  },
  {
    id: "opening_breakout", name: "Opening Range Breakout", posture: ["balanced", "aggressive"], horizon: ["intraday"],
    description: "Enters only when price breaks the opening range with above-average volume.",
    conditions: [
      { type: "opening_range", timeframe: "5Min", parameters: { minutes: "15", operator: "above" } },
      { type: "relative_volume", timeframe: "5Min", parameters: { operator: "above", value: 1.5, lookback: 20 } },
    ], steps: 1, deviation: 3, stepScale: 1, volumeScale: 1, takeProfit: 3, stopLoss: 6,
  },
  {
    id: "bollinger_reversion", name: "Bollinger Reversion", posture: ["balanced", "aggressive"], horizon: ["intraday", "swing"],
    description: "Looks for price beyond the lower band, confirmed by elevated volatility before attempting a rebound trade.",
    conditions: [
      { type: "bollinger", timeframe: "15Min", parameters: { period: 20, deviations: 2, operator: "below_lower" } },
      { type: "atr", timeframe: "15Min", parameters: { period: 14, operator: "above", value: 1.5 } },
    ], steps: 4, deviation: 2, stepScale: 1.2, volumeScale: 1.15, takeProfit: 2.5, stopLoss: 14,
  },
  {
    id: "gap_recovery", name: "Gap Recovery", posture: ["balanced", "aggressive"], horizon: ["intraday"],
    description: "Looks for a moderate gap down followed by a move back above VWAP, avoiding blind entries at the open.",
    conditions: [
      { type: "gap", timeframe: "5Min", parameters: { operator: "down", value: 2 } },
      { type: "vwap", timeframe: "5Min", parameters: { operator: "above" } },
    ], steps: 2, deviation: 2.5, stepScale: 1.1, volumeScale: 1.1, takeProfit: 2.5, stopLoss: 8,
  },
  {
    id: "macd_volume", name: "MACD Volume Confirmation", posture: ["balanced", "aggressive"], horizon: ["intraday", "swing"],
    description: "Combines a bullish MACD crossover with increased relative volume to reduce weak crossover signals.",
    conditions: [
      { type: "macd", timeframe: "15Min", parameters: { fast: 12, slow: 26, signal: 9, operator: "bullish" } },
      { type: "relative_volume", timeframe: "15Min", parameters: { operator: "above", value: 1.25, lookback: 20 } },
    ], steps: 2, deviation: 3, stepScale: 1.15, volumeScale: 1.1, takeProfit: 4, stopLoss: 10,
  },
];

function randomSchedule(strategy, risk) {
  const weights = Array.from({ length: strategy.steps + 1 }, (_, index) => Math.pow(strategy.volumeScale, index));
  const initial = risk / weights.reduce((sum, weight) => sum + weight, 0);
  let deviation = 0;
  return weights.map((weight, step) => {
    if (step) deviation += strategy.deviation * Math.pow(strategy.stepScale, step - 1);
    return { step, deviation, amount: Math.floor(initial * weight * 100) / 100 };
  });
}

function showRandomBotForm() {
  $("#modal-content").innerHTML = `<form id="random-bot-form"><div class="modal-head"><div><h3>Generate a sensible random bot</h3><p>BotGarden chooses from vetted strategy structures and keeps every order inside your risk budget.</p></div><button type="button" class="icon-button" data-close-modal>×</button></div><div class="modal-body"><div class="callout">This creates a draft for paper trading. “Risk budget” is the maximum planned capital allocation, not a guarantee of maximum loss.</div><div class="form-grid"><label>Maximum allocation ($)<input name="risk" type="number" min="50" max="100000" step="10" value="500" required></label><label>Symbol<input name="symbol" value="SPY" maxlength="20" required></label><label>Asset class<select name="assetClass"><option value="equity">Stocks</option><option value="option">Stock options</option></select></label><label>Risk posture<select name="posture"><option value="conservative">Conservative</option><option value="balanced" selected>Balanced</option><option value="aggressive">Aggressive</option></select></label><label>Time horizon<select name="horizon"><option value="intraday" selected>Intraday</option><option value="swing">Swing</option></select></label><label>Trading session<select name="sessionPolicy"><option value="regular">Regular hours only</option><option value="extended">Include extended hours</option></select></label></div><div id="random-preview" class="random-preview"></div><p class="form-message" id="random-message"></p></div><div class="modal-foot"><button type="button" class="secondary" data-close-modal>Cancel</button><button type="button" class="secondary" id="reroll-bot">Try another</button><button class="primary" type="submit">Save this draft</button></div></form>`;
  modal.showModal();
  const form = $("#random-bot-form");
  const randomOptionChoice = form.querySelector('[name="assetClass"] option[value="option"]');
  randomOptionChoice.disabled = true;
  randomOptionChoice.textContent = "Stock options — contract selector coming next";
  let selected = null;
  const roll = () => {
    const data = new FormData(form); const posture = data.get("posture"); const horizon = data.get("horizon");
    const candidates = RANDOM_STRATEGIES.filter((strategy) => strategy.posture.includes(posture) && strategy.horizon.includes(horizon) && strategy.id !== selected?.id);
    selected = candidates[Math.floor(Math.random() * candidates.length)] || RANDOM_STRATEGIES[0];
    const risk = Number(data.get("risk")); const schedule = randomSchedule(selected, risk);
    $("#random-preview").innerHTML = `<span class="eyebrow">CURATED STRATEGY</span><h3>${selected.name}</h3><p>${selected.description}</p><div class="random-stats"><div><span>Conditions</span><strong>${selected.conditions.length} joined with AND</strong></div><div><span>Orders</span><strong>${schedule.length}</strong></div><div><span>Take profit</span><strong>${pct(selected.takeProfit)}</strong></div><div><span>Stop loss</span><strong>${pct(selected.stopLoss)}</strong></div></div><div class="subtle">${selected.conditions.map((condition) => conditionDefinition(condition.type)[1]).join(" + ")}</div>`;
  };
  $("#reroll-bot").addEventListener("click", roll);
  form.querySelectorAll("select").forEach((field) => field.addEventListener("change", roll));
  roll();
  form.addEventListener("submit", async (event) => {
    event.preventDefault(); const button = event.submitter; button.disabled = true;
    const data = new FormData(form); const risk = Number(data.get("risk")); const schedule = randomSchedule(selected, risk);
    const payload = { user_id: session.user.id, name: `${data.get("symbol").toUpperCase().trim()} ${selected.name}`, bot_type: "dca", status: "draft", broker: "alpaca", environment: "paper", asset_class: data.get("assetClass"), symbol: data.get("symbol").toUpperCase().trim(), direction: "long", max_allocation: risk, max_active_trades: 1, start_condition: { operator: "AND", conditions: selected.conditions, generated_strategy: selected.id, sizing_mode: "fixed" }, take_profit_pct: selected.takeProfit, stop_loss_pct: selected.stopLoss, cooldown_seconds: data.get("horizon") === "intraday" ? 1800 : 86400, session_policy: data.get("sessionPolicy") };
    const { data: bot, error } = await supabase.from("bg_bots").insert(payload).select().single();
    if (error) { $("#random-message").textContent = error.message; button.disabled = false; return; }
    const { error: stepError } = await supabase.from("bg_averaging_steps").insert(schedule.map((step) => ({ bot_id: bot.id, step_number: step.step, deviation_pct: step.deviation, order_amount: step.amount })));
    if (stepError) { $("#random-message").textContent = stepError.message; button.disabled = false; return; }
    modal.close(); await loadDashboard();
  });
}

function showBotForm() {
  $("#modal-content").innerHTML = `<form id="bot-form"><div class="modal-head"><div><h3>Create DCA bot</h3><p>Configure a paper-trading averaging strategy.</p></div><button type="button" class="icon-button" data-close-modal>×</button></div><div class="modal-body"><div class="form-grid">
    <label class="span-2">Bot name<input name="name" required placeholder="SPY pullback strategy"></label>
    <label>Asset class<select name="assetClass"><option value="equity">Stocks</option><option value="option">Stock options</option></select></label>
    <label>Symbol<input name="symbol" required value="SPY" maxlength="20"></label>
    <label>Direction<select name="direction"><option value="long">Long</option><option value="short">Short</option></select></label>
    <label>Order sizing<select name="sizingMode"><option value="fixed">Fixed dollar amount</option><option value="percent_equity">Percent of account equity</option></select></label>
    <label>Initial order ($)<input name="initialOrder" type="number" min="1" step=".01" value="100" required></label>
    <label>Averaging orders<input name="stepCount" type="number" min="0" max="20" value="5" required></label>
    <label>Initial price deviation (%)<input name="deviation" type="number" min=".01" step=".01" value="2" required></label>
    <label>Step scale<input name="stepScale" type="number" min=".1" step=".1" value="1" required></label>
    <label>Order-volume scale<input name="volumeScale" type="number" min=".1" step=".1" value="1.5" required></label>
    <label>Take profit (%)<input name="takeProfit" type="number" min=".01" step=".01" value="2" required></label>
    <label>Stop loss (%)<input name="stopLoss" type="number" min="0" step=".01" value="20"></label>
    <label>Trading session<select name="sessionPolicy"><option value="regular">Regular hours only</option><option value="extended">Include extended hours</option></select></label>
    <label>Cooldown between trades (minutes)<input name="cooldownMinutes" type="number" min="0" value="0"></label>
    <label>Maximum active trades<input name="maxActiveTrades" type="number" min="1" max="100" value="1"></label>
  </div><section class="condition-builder"><div class="condition-builder-head"><div><h3>Start conditions</h3><p>Combine up to three rules. All conditions are evaluated on completed candles unless the rule is quote-based.</p></div><div class="logic-control hidden" id="logic-control"><span>Combine with</span><select name="conditionOperator"><option value="AND">AND — all must match</option><option value="OR">OR — any may match</option></select></div></div><div id="condition-list">${renderConditionRow(0)}</div><button type="button" class="secondary" id="add-condition">+ Add condition</button></section><div id="schedule-preview"></div><p class="form-message" id="bot-message"></p></div><div class="modal-foot"><button type="button" class="secondary" data-close-modal>Cancel</button><button class="primary" type="submit">Save draft bot</button></div></form>`;
  modal.showModal();
  const form = $("#bot-form");
  const reindexConditions = () => {
    [...form.querySelectorAll(".condition-row")].forEach((row, index) => {
      row.dataset.conditionIndex = index;
      row.querySelector("strong").textContent = `Condition ${index + 1}`;
      row.querySelectorAll("[name]").forEach((field) => field.name = field.name.replace(/condition_\d+_/, `condition_${index}_`));
    });
    const count = form.querySelectorAll(".condition-row").length;
    $("#logic-control").classList.toggle("hidden", count < 2);
    $("#add-condition").classList.toggle("hidden", count >= 3);
  };
  $("#add-condition").addEventListener("click", () => {
    const count = form.querySelectorAll(".condition-row").length;
    if (count < 3) $("#condition-list").insertAdjacentHTML("beforeend", renderConditionRow(count, "price"));
    const select = form.querySelector(`.condition-row:last-child .condition-type`); select.value = "price"; reindexConditions();
  });
  $("#condition-list").addEventListener("click", (event) => {
    if (!event.target.closest(".remove-condition")) return;
    event.target.closest(".condition-row").remove(); reindexConditions();
  });
  $("#condition-list").addEventListener("change", (event) => {
    if (!event.target.matches(".condition-type")) return;
    const row = event.target.closest(".condition-row"); const index = Number(row.dataset.conditionIndex);
    const [, , params] = conditionDefinition(event.target.value);
    row.querySelector(".condition-params").innerHTML = params.map((param) => paramControl(index, param)).join("");
  });
  const preview = () => {
    const data = new FormData(form); const steps = scheduleFromForm(data);
    $("#schedule-preview").innerHTML = `<table class="schedule"><thead><tr><th>Order</th><th>Price deviation</th><th>Order size</th><th>Cumulative capital</th></tr></thead><tbody>${steps.map((s) => `<tr><td>${s.step ? `Averaging ${s.step}` : "Initial"}</td><td>-${pct(s.deviation)}</td><td>${money(s.amount)}</td><td>${money(s.cumulative)}</td></tr>`).join("")}</tbody></table><p class="danger-note">Maximum planned capital: ${money(steps.at(-1).cumulative)}. Averaging down can magnify losses in a sustained decline.</p>`;
  };
  form.addEventListener("input", preview); preview();
  form.addEventListener("submit", async (event) => {
    event.preventDefault(); const button = event.submitter; button.disabled = true;
    const data = new FormData(form); const schedule = scheduleFromForm(data);
    const payload = { user_id: session.user.id, name: data.get("name"), bot_type: "dca", status: "draft", broker: "alpaca", environment: "paper", asset_class: data.get("assetClass"), symbol: data.get("symbol").toUpperCase().trim(), direction: data.get("direction"), max_allocation: schedule.at(-1).cumulative, max_active_trades: Number(data.get("maxActiveTrades")), start_condition: { ...readConditions(form), sizing_mode: data.get("sizingMode") }, take_profit_pct: Number(data.get("takeProfit")), stop_loss_pct: Number(data.get("stopLoss")) || null, cooldown_seconds: Number(data.get("cooldownMinutes")) * 60, session_policy: data.get("sessionPolicy") };
    const { data: bot, error } = await supabase.from("bg_bots").insert(payload).select().single();
    if (error) { $("#bot-message").textContent = error.message; button.disabled = false; return; }
    const rows = schedule.map((s) => ({ bot_id: bot.id, step_number: s.step, deviation_pct: s.deviation, order_amount: s.amount }));
    const { error: stepError } = await supabase.from("bg_averaging_steps").insert(rows);
    if (stepError) { $("#bot-message").textContent = stepError.message; button.disabled = false; return; }
    modal.close(); await loadDashboard();
  });
}

boot();
