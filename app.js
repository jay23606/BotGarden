import { configured, supabase, invoke, money, pct, escapeHtml } from "./core.js";

const $ = (s) => document.querySelector(s);
const authView = $("#auth-view");
const appView = $("#app-view");
const content = $("#page-content");
const modal = $("#modal");
let session = null;
let authMode = "signin";
let bots = [];
let backtestSummary = new Map();
let latestBacktest = new Map();

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
$("#random-option-bot").addEventListener("click", showRandomOptionBotForm);
$("#random-ten").addEventListener("click", showBulkRandomForm);
$("#prune-bots").addEventListener("click", pruneUnderperformingBots);
document.addEventListener("click", (event) => {
  const nav = event.target.closest("[data-view]");
  if (nav) switchView(nav.dataset.view);
  if (event.target.closest("[data-new-bot]")) showBotForm();
  if (event.target.closest("[data-connect]")) showConnectionForm();
  const details = event.target.closest("[data-bot-details]"); if (details) showBotDetails(details.dataset.botDetails);
  const backtest = event.target.closest("[data-backtest]"); if (backtest) showBacktestForm(backtest.dataset.backtest);
  const child = event.target.closest("[data-child-bot]"); if (child) createRandomChild(child.dataset.childBot, child);
  const toggle = event.target.closest("[data-toggle-bot]"); if (toggle) toggleBot(toggle.dataset.toggleBot);
  const remove = event.target.closest("[data-delete-bot]"); if (remove) deleteBot(remove.dataset.deleteBot, remove);
  if (event.target.closest("[data-close-modal]")) modal.close();
});

async function getConnection() {
  const { data } = await supabase.from("bg_broker_connections").select("id,broker,environment,account_number,status,last_verified_at").eq("broker", "alpaca").maybeSingle();
  return data;
}

async function loadDashboard() {
  const [{ data: botData }, connection, { data: backtests }] = await Promise.all([
    supabase.from("bg_bots").select("id,name,bot_type,status,asset_class,symbol,direction,max_allocation,max_active_trades,start_condition,take_profit_pct,stop_loss_pct,cooldown_seconds,session_policy,created_at").order("created_at", { ascending: false }),
    getConnection(),
    supabase.from("bg_backtests").select("bot_id,status,duration_seconds,initial_capital,net_pnl,return_pct,signal_count,estimated_pnl,estimated_return_pct,daily_regimes,start_at,end_at,created_at").in("status", ["completed", "signal_only"]),
  ]);
  backtestSummary = new Map();
  latestBacktest = new Map();
  (backtests || []).forEach((test) => { const current = backtestSummary.get(test.bot_id) || { seconds: 0, runs: 0, signalOnlyRuns: 0, signals: 0, pnl: 0, capital: 0, profitPct: null, estimatedPnl: 0, estimatedCapital: 0, estimatedPct: null }; current.seconds += Number(test.duration_seconds); current.runs++; if (test.status === "signal_only") { current.signalOnlyRuns++; current.signals += Number(test.signal_count || 0); if (test.estimated_pnl != null) { current.estimatedPnl += Number(test.estimated_pnl); current.estimatedCapital += Number(test.initial_capital); current.estimatedPct = current.estimatedPnl / current.estimatedCapital * 100; } } if (test.net_pnl != null) { current.pnl += Number(test.net_pnl); current.capital += Number(test.initial_capital); current.profitPct = current.capital ? current.pnl / current.capital * 100 : null; } backtestSummary.set(test.bot_id, current); const latest = latestBacktest.get(test.bot_id); if (!latest || new Date(test.created_at) > new Date(latest.created_at)) latestBacktest.set(test.bot_id, test); });
  bots = (botData || []).sort((a, b) => { const aProfit = backtestSummary.get(a.id)?.profitPct, bProfit = backtestSummary.get(b.id)?.profitPct; if (aProfit != null || bProfit != null) return (bProfit ?? -Infinity) - (aProfit ?? -Infinity); return new Date(b.created_at) - new Date(a.created_at); });
  updatePruneButton();
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
    <div class="runner-note"><strong>Paper execution worker active.</strong> ON stock and option bots are evaluated every five minutes and may submit Alpaca paper orders when every start condition, risk, liquidity, and position check passes.</div>
    <div class="section-head"><h3>Recent bots</h3></div>${renderBots()}`;
}

function actionIcon(name) {
  const paths = { details: `<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/>`, test: `<path d="M4 19V9M10 19V4M16 19v-7M22 19H2"/>`, child: `<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.5 6H12a4 4 0 0 1 4 4v5.5M12 3v6M9 6h6"/>` };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
}

function stockSparkline(bot) {
  const test = latestBacktest.get(bot.id), days = test?.daily_regimes || [];
  if (!days.length) return `<div class="sparkline-placeholder" title="Run a backtest or replay to chart the underlying">No chart yet</div>`;
  const closesAvailable = days.every((day) => Number.isFinite(Number(day.close_price))), values = [closesAvailable ? Number(days[0].open_price || days[0].close_price) : 100];
  days.forEach((day) => values.push(closesAvailable ? Number(day.close_price) : values.at(-1) * (1 + Number(day.return_pct || 0) / 100)));
  const width = 104, height = 34, min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const points = values.map((value, index) => `${(index / Math.max(1, values.length - 1) * width).toFixed(1)},${(height - 3 - (value - min) / span * (height - 6)).toFixed(1)}`).join(" ");
  const change = (values.at(-1) / values[0] - 1) * 100, color = change >= 0 ? "#188653" : "#a33a3a", label = `${days.length}D ${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;
  return `<div class="sparkline" title="${escapeHtml(bot.symbol)} underlying performance over the latest ${days.length}-market-day test"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><line x1="0" y1="${height - 3}" x2="${width}" y2="${height - 3}"/><polyline points="${points}" style="stroke:${color}"/></svg><span style="color:${color}">${label}</span></div>`;
}

function renderBots() {
  if (!bots.length) return `<div class="empty"><h3>No bots yet</h3><div>Create a DCA bot and preview its complete averaging schedule.</div><button class="primary" data-new-bot>Create your first bot</button></div>`;
  const row = (bot, isOption) => {
    const summary = backtestSummary.get(bot.id) || { seconds: 0, runs: 0, signalOnlyRuns: 0, signals: 0, profitPct: null, estimatedPct: null }, isOn = bot.status === "active";
    const performance = isOption ? (summary.estimatedPct == null ? (summary.signalOnlyRuns ? "No estimate" : "Not tested") : `~${pct(summary.estimatedPct)}`) : (summary.profitPct == null ? "Not tested" : pct(summary.profitPct));
    const coverage = isOption ? `${summary.signals} triggers · ${formatDuration(summary.seconds)}${summary.estimatedPct == null ? "" : " · low confidence"}` : `${formatDuration(summary.seconds)} · ${summary.runs} run${summary.runs === 1 ? "" : "s"}`;
    const performanceClass = isOption ? (summary.estimatedPct > 0 ? "profit" : summary.estimatedPct < 0 ? "loss" : "") : (summary.profitPct > 0 ? "profit" : summary.profitPct < 0 ? "loss" : "");
    return `<div class="bot-row"><div><div class="bot-name">${escapeHtml(bot.name)}</div><div class="subtle">${escapeHtml(bot.symbol)} · ${escapeHtml(bot.bot_type.replaceAll("_", " "))}</div></div><button class="bot-toggle ${isOn ? "on" : ""}" data-toggle-bot="${bot.id}" role="switch" aria-checked="${isOn}"><span></span>${isOn ? "ON" : "OFF"}</button><div><div class="subtle">${isOption ? "ESTIMATED REPLAY" : "BACKTEST PROFIT"}</div><strong class="${performanceClass}">${performance}</strong><div class="subtle">${coverage}</div></div>${stockSparkline(bot)}<div><div class="subtle">MAX ${isOption ? "RISK" : "ALLOCATION"}</div>${money(bot.max_allocation)}</div><div class="row-actions"><button class="icon-action" data-bot-details="${bot.id}" title="View bot details" aria-label="View details for ${escapeHtml(bot.name)}">${actionIcon("details")}</button><button class="icon-action test" data-backtest="${bot.id}" title="${isOption ? "Replay" : "Backtest"} this bot" aria-label="${isOption ? "Replay" : "Backtest"} ${escapeHtml(bot.name)}">${actionIcon("test")}</button><button class="icon-action child" data-child-bot="${bot.id}" title="Add a randomized child and test it over the same number of days" aria-label="Add random child of ${escapeHtml(bot.name)}">${actionIcon("child")}</button><button class="delete-button" data-delete-bot="${bot.id}" title="Remove bot" aria-label="Delete ${escapeHtml(bot.name)}">×</button></div></div>`;
  };
  const stocks = bots.filter((bot) => bot.asset_class !== "option"), options = bots.filter((bot) => bot.asset_class === "option").sort((a, b) => (backtestSummary.get(b.id)?.estimatedPct ?? -Infinity) - (backtestSummary.get(a.id)?.estimatedPct ?? -Infinity));
  return `<div class="bot-groups">${stocks.length ? `<section><div class="group-heading"><div><h3>Stock bots</h3><p>Ranked by weighted historical return</p></div><span>${stocks.length}</span></div><div class="bot-list">${stocks.map((bot) => row(bot, false)).join("")}</div></section>` : ""}${options.length ? `<section><div class="group-heading"><div><h3>Option strategies</h3><p>Ranked by estimated historical replay return</p></div><span>${options.length}</span></div><div class="option-explainer">Estimated replay uses underlying moves, configured delta, premium, width, time decay, and a liquidity haircut. It is a low-confidence pruning aid—not actual historical option P&amp;L.</div><div class="bot-list">${options.map((bot) => row(bot, true)).join("")}</div></section>` : ""}</div>`;
}

async function toggleBot(botId) {
  const bot = bots.find((item) => item.id === botId); if (!bot) return;
  const next = bot.status === "active" ? "paused" : "active";
  const { error } = await supabase.from("bg_bots").update({ status: next, updated_at: new Date().toISOString() }).eq("id", botId);
  if (!error) await loadDashboard();
}

async function deleteBot(botId, button) {
  button.disabled = true; const { error } = await supabase.from("bg_bots").delete().eq("id", botId); if (error) { button.disabled = false; console.error("Bot removal failed", error); return; } await loadDashboard();
}

async function createRandomChild(botId, button) {
  const parent = bots.find((bot) => bot.id === botId); if (!parent) return;
  const latest = latestBacktest.get(botId), marketDays = Math.max(1, Math.min(60, Number(latest?.daily_regimes?.length) || Math.round(Number(latest?.duration_seconds || 432000) / 86400) || 5));
  button.disabled = true; button.classList.add("working"); const originalTitle = button.title; button.title = `Creating and testing ${marketDays}-day child…`; let childId = null;
  try {
    if (parent.asset_class === "option") {
      const { data: spread, error: spreadReadError } = await supabase.from("bg_option_spreads").select("*").eq("bot_id", parent.id).single(); if (spreadReadError) throw spreadReadError;
      const family = spread.strategy_family || "credit_spread", template = OPTION_STRATEGIES.find((strategy) => strategy.id === parent.start_condition?.generated_strategy) || OPTION_STRATEGIES.find((strategy) => strategy.family === family && strategy.bias === (parent.direction === "short" ? "bearish" : "bullish")) || OPTION_STRATEGIES[0];
      const posture = parent.start_condition?.randomized_fields?.["Risk profile"] || "balanced", selected = randomizedOptionStrategy(template, posture), width = Number(spread.target_width || 0), rawPremium = Number(spread.target_premium || spread.minimum_credit) * randomStep(.85, 1.15, .05), premium = Number(Math.max(.05, family === "credit_spread" ? Math.min(width - .05, rawPremium) : rawPremium).toFixed(2));
      const riskPerContract = Math.max(.01, (family === "credit_spread" ? width - premium : premium) * 100), contracts = Math.max(1, Math.floor(Number(parent.max_allocation) / riskPerContract)), totalRisk = contracts * riskPerContract, profitClose = Math.max(20, Math.min(70, Number(spread.profit_close_pct) + pick([-5, 0, 5])));
      const { data: child, error } = await supabase.from("bg_bots").insert({ user_id: session.user.id, name: `${parent.name} Child`, bot_type: "option_strategy", status: "active", broker: "alpaca", environment: "paper", asset_class: "option", symbol: parent.symbol, direction: selected.bias === "bullish" ? "long" : "short", max_allocation: totalRisk, max_active_trades: 1, start_condition: { operator: "AND", conditions: selected.conditions, generated_strategy: selected.id, generation_id: selected.generationId, parent_bot_id: parent.id, generation_kind: "child", randomized_fields: { ...selected.randomizedFields, Parent: parent.name, "Target premium": money(premium) } }, take_profit_pct: profitClose, stop_loss_pct: null, cooldown_seconds: parent.cooldown_seconds, session_policy: parent.session_policy }).select().single(); if (error) throw error; childId = child.id;
      const { error: childSpreadError } = await supabase.from("bg_option_spreads").insert({ bot_id: child.id, spread_type: selected.spreadType, strategy_family: family, premium_type: family === "credit_spread" ? "credit" : "debit", min_dte: spread.min_dte, max_dte: spread.max_dte, short_delta_target: selected.delta, target_width: width, minimum_credit: premium, target_premium: premium, max_bid_ask_pct: spread.max_bid_ask_pct, contracts, max_risk: totalRisk, profit_close_pct: profitClose, loss_close_multiple: selected.lossCloseMultiple, exit_dte: spread.exit_dte }); if (childSpreadError) throw childSpreadError;
    } else {
      const template = RANDOM_STRATEGIES.find((strategy) => strategy.id === parent.start_condition?.generated_strategy) || RANDOM_STRATEGIES[0], fields = parent.start_condition?.randomized_fields || {}, posture = fields["Risk profile"] || "balanced", horizon = fields["Time horizon"] || (Number(parent.cooldown_seconds) >= 86400 ? "swing" : "intraday"), selected = randomizedStockStrategy(template, posture, horizon, parent.symbol), schedule = randomSchedule(selected, Number(parent.max_allocation));
      const { data: child, error } = await supabase.from("bg_bots").insert({ user_id: session.user.id, name: `${parent.name} Child`, bot_type: "dca", status: "active", broker: "alpaca", environment: "paper", asset_class: "equity", symbol: parent.symbol, direction: parent.direction, max_allocation: parent.max_allocation, max_active_trades: parent.max_active_trades, start_condition: { operator: "AND", conditions: selected.conditions, generated_strategy: selected.id, generation_id: selected.generationId, parent_bot_id: parent.id, generation_kind: "child", randomized_fields: { ...selected.randomizedFields, Parent: parent.name }, volatility_model: selected.volatilityModel, sizing_mode: "fixed" }, take_profit_pct: selected.takeProfit, stop_loss_pct: selected.stopLoss, cooldown_seconds: parent.cooldown_seconds, session_policy: parent.session_policy }).select().single(); if (error) throw error; childId = child.id;
      const { error: stepsError } = await supabase.from("bg_averaging_steps").insert(schedule.map((step) => ({ bot_id: child.id, step_number: step.step, deviation_pct: step.deviation, order_amount: step.amount }))); if (stepsError) throw stepsError;
    }
    await autoBacktest(childId, marketDays); await loadDashboard();
  } catch (error) {
    console.error("Child bot creation failed", error); if (childId) await supabase.from("bg_bots").delete().eq("id", childId); button.disabled = false; button.classList.remove("working"); button.title = `Child failed: ${error.message || "try again"}`; setTimeout(() => button.title = originalTitle, 5000);
  }
}

function botsBelowThreshold(threshold = 2) {
  return bots.filter((bot) => {
    const summary = backtestSummary.get(bot.id);
    const result = bot.asset_class === "option" ? summary?.estimatedPct : summary?.profitPct;
    return result == null || !Number.isFinite(result) || result < threshold;
  });
}

function updatePruneButton() {
  const button = $("#prune-bots"); if (!button) return;
  const count = botsBelowThreshold().length;
  button.disabled = count === 0;
  button.textContent = count ? `Remove <2% + untested (${count})` : "Remove <2% + untested";
  button.title = count ? `Immediately remove ${count} bot${count === 1 ? "" : "s"} below 2%, not tested, or without an option estimate` : "No bots are below 2%, untested, or missing an option estimate";
}

async function pruneUnderperformingBots() {
  const button = $("#prune-bots");
  const candidates = botsBelowThreshold(); if (!candidates.length) return;
  button.disabled = true; button.textContent = `Removing ${candidates.length}…`;
  const { error } = await supabase.from("bg_bots").delete().in("id", candidates.map((bot) => bot.id));
  if (error) { console.error("Bulk bot removal failed", error); button.textContent = "Removal failed — retry"; button.disabled = false; return; }
  await loadDashboard();
}

function formatDuration(seconds) {
  const days = Math.floor(Number(seconds || 0) / 86400); const hours = Math.floor((Number(seconds || 0) % 86400) / 3600);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h` : "Not yet";
}

async function showBotDetails(botId) {
  const bot = bots.find((item) => item.id === botId); if (!bot) return;
  const rule = bot.start_condition || {}; const conditions = rule.conditions || [];
  const [{ data: steps }, { data: spread }, { data: recentTests }, insights] = await Promise.all([
    supabase.from("bg_averaging_steps").select("step_number,deviation_pct,order_amount").eq("bot_id", bot.id).order("step_number"),
    supabase.from("bg_option_spreads").select("*").eq("bot_id", bot.id).maybeSingle(),
    supabase.from("bg_backtests").select("id,status,start_at,end_at,duration_seconds,net_pnl,return_pct,signal_count,estimated_pnl,estimated_return_pct,estimate_low_pct,estimate_high_pct,estimate_confidence,market_regime,market_return_pct,volatility_label,created_at").eq("bot_id", bot.id).in("status", ["completed", "signal_only"]).order("created_at", { ascending: false }).limit(8),
    invoke("ticker-insights", { symbol: bot.symbol }).catch((error) => ({ error: error.message || "Ticker information unavailable" })),
  ]);
  const generatedValues = spread ? `<h3 class="detail-title">Generated spread settings</h3><div class="detail-grid"><div><span>Structure</span><strong>${escapeHtml(spread.spread_type.replaceAll("_", " "))}</strong></div><div><span>Expiration</span><strong>${spread.min_dte}–${spread.max_dte} DTE</strong></div><div><span>Short delta</span><strong>${Number(spread.short_delta_target).toFixed(2)}</strong></div><div><span>Width</span><strong>${money(spread.target_width)}</strong></div><div><span>Minimum credit</span><strong>${money(spread.minimum_credit)}</strong></div><div><span>Contracts</span><strong>${spread.contracts}</strong></div><div><span>Profit close</span><strong>${pct(spread.profit_close_pct)}</strong></div><div><span>Exit</span><strong>${spread.exit_dte} DTE</strong></div></div>` : steps?.length ? `<h3 class="detail-title">Generated order schedule</h3><table class="schedule"><thead><tr><th>Order</th><th>Deviation</th><th>Amount</th></tr></thead><tbody>${steps.map((step) => `<tr><td>${step.step_number ? `Averaging ${step.step_number}` : "Initial"}</td><td>-${pct(step.deviation_pct)}</td><td>${money(step.order_amount)}</td></tr>`).join("")}</tbody></table>` : "";
  const randomizedAudit = Object.entries(rule.randomized_fields || {}).map(([key, value]) => `<span><b>${escapeHtml(key)}:</b> ${escapeHtml(value)}</span>`).join("");
  const generated = rule.generated_strategy ? `<div class="callout"><strong>Generated configuration</strong><br>Curated template: ${escapeHtml(rule.generated_strategy.replaceAll("_", " "))}. Bounded random values are recorded below.${randomizedAudit ? `<div class="randomized-list">${randomizedAudit}</div>` : ""}</div>` : "";
  const history = recentTests?.length ? `<div class="test-history">${recentTests.map((test) => `<div><div><strong>${new Date(test.start_at).toLocaleDateString()} – ${new Date(test.end_at).toLocaleDateString()}</strong><span>${escapeHtml(test.market_regime || "Unclassified")} · ${escapeHtml(test.volatility_label || "Unknown")} volatility · market ${pct(test.market_return_pct)}</span></div><div class="test-outcome"><strong>${test.status === "signal_only" ? (test.estimated_return_pct == null ? `${test.signal_count} signals` : `~${pct(test.estimated_return_pct)}`) : money(test.net_pnl)}</strong><span>${test.status === "signal_only" ? (test.estimated_return_pct == null ? "No estimate" : `${money(test.estimated_pnl)} modeled · ${pct(test.estimate_low_pct)} to ${pct(test.estimate_high_pct)}`) : `${pct(test.return_pct)} bot return`}</span></div></div>`).join("")}</div>` : `<div class="empty compact"><strong>No completed backtests yet</strong></div>`;
  const compact = (value) => value == null ? "—" : new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value));
  const premium = Number(spread?.target_premium || spread?.minimum_credit || 0), width = Number(spread?.target_width || 0), contracts = Number(spread?.contracts || 0), family = spread?.strategy_family;
  const maximumLoss = spread ? Number(spread.max_risk || bot.max_allocation) : Number(bot.max_allocation), plannedStopLoss = !spread && bot.stop_loss_pct ? Number(bot.max_allocation) * Number(bot.stop_loss_pct) / 100 : null;
  const maximumProfit = spread ? (family === "credit_spread" ? premium * 100 * contracts : family === "debit_spread" ? Math.max(0, width - premium) * 100 * contracts : null) : bot.take_profit_pct ? Number(bot.max_allocation) * Number(bot.take_profit_pct) / 100 : null;
  const riskMetrics = `<h3 class="detail-title">Risk and payoff</h3><div class="risk-callout">${spread ? "Defined-risk option structure based on saved width, premium, and contract count." : "A stop is an intended exit, not a guaranteed fill. A long stock position can still lose its full allocation during a severe gap or failed exit."}</div><div class="detail-grid risk-grid"><div><span>${spread ? "Modeled maximum loss" : "Capital at risk"}</span><strong class="loss">${money(maximumLoss)}</strong></div><div><span>${spread ? (family === "long_option" ? "Maximum profit" : "Modeled maximum profit") : "Target gain on allocation"}</span><strong>${maximumProfit == null ? "Open-ended" : money(maximumProfit)}</strong></div><div><span>Planned stop-loss exposure</span><strong>${spread ? (spread.loss_close_multiple == null ? "Not configured" : `${Number(spread.loss_close_multiple).toFixed(2)}× premium`) : plannedStopLoss == null ? "No automated stock stop" : `${money(plannedStopLoss)} at ${pct(bot.stop_loss_pct)}`}</strong></div><div><span>Reward / maximum-risk ratio</span><strong>${maximumProfit == null || !maximumLoss ? "Not bounded" : `${(maximumProfit / maximumLoss).toFixed(2)}×`}</strong></div></div>`;
  const market = insights?.market, asset = insights?.asset, dayChange = market?.price && market?.previous_close ? (Number(market.price) / Number(market.previous_close) - 1) * 100 : null;
  const tickerInfo = insights?.error ? `<h3 class="detail-title">Ticker intelligence</h3><div class="risk-callout muted">${escapeHtml(insights.error)}</div>` : `<h3 class="detail-title">${escapeHtml(bot.symbol)} ticker intelligence</h3><div class="ticker-heading"><div><strong>${escapeHtml(asset?.name || bot.symbol)}</strong><span>${escapeHtml([asset?.exchange, asset?.status].filter(Boolean).join(" · "))}</span></div><div><strong>${money(market?.price)}</strong><span class="${dayChange > 0 ? "profit" : dayChange < 0 ? "loss" : ""}">${dayChange == null ? "—" : `${dayChange >= 0 ? "+" : ""}${pct(dayChange)} today`}</span></div></div><div class="detail-grid ticker-grid"><div><span>5-day move</span><strong>${market?.change_5d_pct == null ? "—" : pct(market.change_5d_pct)}</strong></div><div><span>20-day move</span><strong>${market?.change_20d_pct == null ? "—" : pct(market.change_20d_pct)}</strong></div><div><span>Annualized volatility</span><strong>${pct(market?.annualized_volatility_pct)}</strong></div><div><span>60-day max drawdown</span><strong class="loss">${pct(market?.max_drawdown_60d_pct)}</strong></div><div><span>ATR (14 days)</span><strong>${money(market?.atr_14)} · ${pct(market?.atr_14_pct)}</strong></div><div><span>20-day average volume</span><strong>${compact(market?.average_volume_20d)}</strong></div><div><span>Latest relative volume</span><strong>${market?.relative_volume == null ? "—" : `${Number(market.relative_volume).toFixed(2)}×`}</strong></div><div><span>Current quote spread</span><strong>${market?.spread_pct == null ? "—" : pct(market.spread_pct)}</strong></div></div><div class="asset-flags"><span class="${asset?.tradable ? "on" : ""}">Tradable</span><span class="${asset?.fractionable ? "on" : ""}">Fractional</span><span class="${asset?.shortable ? "on" : ""}">Shortable</span><span class="${asset?.options_enabled ? "on" : ""}">Options</span><small>Alpaca IEX · as of ${market?.as_of ? new Date(market.as_of).toLocaleString() : "latest available"}</small></div>`;
  const newsItems = insights?.news || [], tickerNews = `<div class="section-head"><h3>Recent ${escapeHtml(bot.symbol)} news</h3><span class="subtle">Via Alpaca / Benzinga</span></div>${newsItems.length ? `<div class="ticker-news">${newsItems.map((item) => { const url = /^https?:\/\//i.test(item.url || "") ? item.url : "#"; return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"><span>${escapeHtml(item.source || "News")} · ${new Date(item.created_at).toLocaleString()}</span><strong>${escapeHtml(item.headline)}</strong>${item.summary ? `<p>${escapeHtml(item.summary)}</p>` : ""}</a>`; }).join("")}</div>` : `<div class="empty compact"><strong>No recent ticker-specific news returned</strong></div>`}`;
  $("#modal-content").innerHTML = `<div class="modal-head"><div><h3>${escapeHtml(bot.name)}</h3><p>${escapeHtml(bot.symbol)} · ${escapeHtml(bot.bot_type.replaceAll("_", " "))}</p></div><button type="button" class="icon-button" data-close-modal>×</button></div><div class="modal-body">${generated}<div class="detail-grid"><div><span>Maximum allocation</span><strong>${money(bot.max_allocation)}</strong></div><div><span>Take profit</span><strong>${bot.take_profit_pct ? pct(bot.take_profit_pct) : "Spread rule"}</strong></div><div><span>Stop loss</span><strong>${bot.stop_loss_pct ? pct(bot.stop_loss_pct) : "Defined by spread"}</strong></div><div><span>Session</span><strong>${escapeHtml(bot.session_policy)}</strong></div></div>${riskMetrics}${tickerInfo}${tickerNews}<h3 class="detail-title">Start rules (${escapeHtml(rule.operator || "AND")})</h3><div class="rule-list">${conditions.map((condition) => `<div><strong>${escapeHtml(conditionDefinition(condition.type)[1])}</strong><span>${escapeHtml(condition.timeframe || "")} · ${escapeHtml(Object.entries(condition.parameters || {}).map(([key, value]) => `${key}: ${value}`).join(", "))}</span></div>`).join("") || "No structured rules saved."}</div>${generatedValues}<div class="section-head"><h3>${bot.asset_class === "option" ? "Signal-test history" : "Backtest history"}</h3><span class="subtle">${formatDuration(backtestSummary.get(bot.id)?.seconds || 0)} total coverage</span></div>${history}</div><div class="modal-foot"><button class="secondary" data-close-modal>Close</button><button class="primary" data-backtest="${bot.id}">${bot.asset_class === "option" ? "Test signals" : "Backtest"}</button></div>`;
  modal.showModal();
}

function showBacktestForm(botId) {
  const bot = bots.find((item) => item.id === botId); if (!bot) return;
  const end = new Date(); end.setDate(end.getDate() - 1); const start = new Date(end); start.setDate(start.getDate() - 7);
  const dateValue = (date) => date.toISOString().slice(0, 10);
  $("#modal-content").innerHTML = `<form id="backtest-form"><div class="modal-head"><div><h3>${bot.asset_class === "option" ? "Test signals for" : "Backtest"} ${escapeHtml(bot.name)}</h3><p>${bot.asset_class === "option" ? "Tests the underlying entry signals only; option P&L is not estimated." : "Simulates entries, averaging orders, take profit, and stop loss on historical IEX bars."}</p></div><button type="button" class="icon-button" data-close-modal>×</button></div><div class="modal-body"><div class="callout">Results exclude fees and slippage. Alpaca Basic uses IEX rather than the consolidated market feed. Maximum range per run is 31 days.</div><div class="form-grid"><label>Start date<input name="start" type="date" value="${dateValue(start)}" required></label><label>End date<input name="end" type="date" value="${dateValue(end)}" required></label></div><div id="backtest-result"></div><p class="form-message" id="backtest-message"></p></div><div class="modal-foot"><button type="button" class="secondary" data-close-modal>Cancel</button><button class="primary" type="submit">${bot.asset_class === "option" ? "Test signals" : "Run backtest"}</button></div></form>`;
  if (modal.open) modal.close(); modal.showModal();
  $("#backtest-form").addEventListener("submit", async (event) => {
    event.preventDefault(); const button = event.submitter; button.disabled = true; button.textContent = "Running…"; $("#backtest-message").textContent = "";
    try {
      const data = new FormData(event.currentTarget); const result = await invoke("backtest-bot", { botId, start: `${data.get("start")}T14:30:00Z`, end: `${data.get("end")}T21:00:00Z` });
      $("#backtest-result").innerHTML = `<div class="backtest-result"><div><span>Coverage</span><strong>${formatDuration(result.duration_seconds)}</strong></div><div><span>Signals</span><strong>${result.signal_count}</strong></div><div><span>${result.status === "signal_only" ? "Option P&L" : "Net P&L"}</span><strong>${result.status === "signal_only" ? "Not modeled" : money(result.net_pnl)}</strong></div><div><span>Bot return</span><strong>${result.return_pct == null ? "—" : pct(result.return_pct)}</strong></div><div><span>Market regime</span><strong>${escapeHtml(result.market_regime)}</strong></div><div><span>Market return</span><strong>${pct(result.market_return_pct)}</strong></div><div><span>Volatility</span><strong>${escapeHtml(result.volatility_label)}</strong></div><div><span>Trades</span><strong>${result.trade_count}</strong></div><div><span>Max drawdown</span><strong>${result.max_drawdown_pct == null ? "—" : pct(result.max_drawdown_pct)}</strong></div></div>${result.daily_regimes?.length ? `<div class="daily-regimes"><h3>Day-by-day context</h3>${result.daily_regimes.map((day) => `<div><span>${escapeHtml(day.date)}</span><strong>${escapeHtml(day.regime)}</strong><span>${escapeHtml(day.volatility)} volatility</span><span>${pct(day.return_pct)}</span></div>`).join("")}</div>` : ""}`;
      button.textContent = "Run again"; button.disabled = false; await loadDashboard();
    } catch (error) { $("#backtest-message").textContent = error.message || "Backtest failed"; button.textContent = "Run backtest"; button.disabled = false; }
  });
}

let activityTimer = null;
async function loadActivity() {
  const [{ data: statuses }, { data: activityBots }] = await Promise.all([supabase.from("bg_bot_status").select("*").order("checked_at", { ascending: false }), supabase.from("bg_bots").select("id,name,symbol,status,asset_class").order("created_at", { ascending: false })]); const statusByBot = new Map((statuses || []).map((status) => [status.bot_id, status]));
  const cards = (activityBots || []).map((bot) => { const status = statusByBot.get(bot.id); if (bot.status !== "active") return `<article class="decision-card muted"><div class="decision-head"><div><strong>${escapeHtml(bot.name)}</strong><span>${escapeHtml(bot.symbol)} · OFF</span></div><b>Paused</b></div><p>This bot is OFF and was not evaluated in the current cycle.</p></article>`; if (!status) return `<article class="decision-card"><div class="decision-head"><div><strong>${escapeHtml(bot.name)}</strong><span>${escapeHtml(bot.symbol)} · waiting</span></div><b>Pending</b></div><p>Waiting for its first scheduled evaluation.</p></article>`; const conditions = status.details?.conditions || []; return `<article class="decision-card ${status.reason_code === "error" ? "error" : status.reason_code.includes("submitted") ? "success" : ""}"><div class="decision-head"><div><strong>${escapeHtml(bot.name)}</strong><span>${escapeHtml(bot.symbol)} · checked ${new Date(status.checked_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span></div><b>${escapeHtml(status.reason_code.replaceAll("_", " "))}</b></div><p>${escapeHtml(status.message)}</p>${conditions.length ? `<div class="condition-status">${conditions.map((condition) => `<span class="${condition.passed ? "pass" : "fail"}">${condition.passed ? "✓" : "×"} ${escapeHtml(conditionDefinition(condition.type)[1])}</span>`).join("")}</div>` : ""}${status.details?.last_price ? `<div class="subtle">Last price ${money(status.details.last_price)} · ${escapeHtml(status.details.timeframe || "")}</div>` : ""}</article>`; }).join("");
  content.innerHTML = `<div class="activity-summary"><div><span class="eyebrow">LATEST WORKER CYCLE</span><h3>Why each bot acted—or waited</h3><p>One status per bot is replaced every five-minute cycle. This page refreshes automatically every 30 seconds.</p></div><button class="secondary" id="refresh-activity">Refresh now</button></div><div class="decision-list">${cards || `<div class="empty"><h3>No bots configured</h3></div>`}</div>`; $("#refresh-activity")?.addEventListener("click", loadActivity); clearTimeout(activityTimer); activityTimer = setTimeout(() => document.querySelector('[data-view="activity"]')?.classList.contains("active") && loadActivity(), 30000);
}

function switchView(view) {
  if (view !== "activity") { clearTimeout(activityTimer); activityTimer = null; }
  document.querySelectorAll(".nav-item[data-view]").forEach((el) => el.classList.toggle("active", el.dataset.view === view));
  $("#page-title").textContent = ({ dashboard: "Overview", bots: "Bots", activity: "Activity", settings: "Settings" })[view];
  if (view === "dashboard") return loadDashboard();
  if (view === "bots") return content.innerHTML = `<div class="section-head"><h3>All bots</h3></div>${renderBots()}`;
  if (view === "activity") return loadActivity();
  content.innerHTML = `<div class="section-head"><h3>Broker connections</h3></div><div class="card connection-card"><p>Connect an Alpaca paper account using credentials created in your Alpaca dashboard.</p><button class="primary" data-connect>Connect Alpaca</button></div><div class="section-head"><h3>Paper execution capacity</h3></div><div class="settings-grid"><div class="card"><span class="eyebrow">ACTIVE SCHEDULE</span><h3>Every five minutes</h3><p>The shared worker evaluates ON stock and option bots during Alpaca market hours. OFF bots cannot create new entries.</p></div><div class="card"><span class="eyebrow">OPTION EXECUTION</span><h3>Live chain + atomic spreads</h3><p>Contracts are selected from current Greeks and quotes. Vertical spreads enter and exit as atomic Alpaca multi-leg paper orders.</p></div><div class="card"><span class="eyebrow">ORDER SAFETY</span><h3>Risk and exposure gates</h3><p>Orders fail closed if liquidity, premium, width, risk, or contract checks fail. Existing positions and open orders block another entry.</p></div><div class="card"><span class="eyebrow">EXIT MANAGEMENT</span><h3>Profit, loss, and expiration</h3><p>Open option legs are monitored as one strategy and closed together at the configured profit target, loss limit, or exit DTE.</p></div></div><div class="section-head"><h3>Backtest data notes</h3></div><div class="card note-card"><h3>Why option bots show “Signal-only”</h3><p>Live option execution uses the current chain. Historical chain-and-Greeks snapshots are not available in the same form, so historical tests record underlying triggers without inventing option P&amp;L.</p></div>`;
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
    id: "rsi_vwap", family: "pullback", selectionWeight: 20, name: "RSI + VWAP Reversion", posture: ["conservative", "balanced"], horizon: ["intraday", "swing"],
    description: "Waits for an oversold reading and price below VWAP before averaging into a potential rebound.",
    conditions: [
      { type: "rsi", timeframe: "5Min", parameters: { period: 14, operator: "below", value: 30 } },
      { type: "vwap", timeframe: "5Min", parameters: { operator: "below" } },
      { type: "moving_average", timeframe: "5Min", parameters: { average: "ema", fast: 20, slow: 50, operator: "above" } },
    ], steps: 3, deviation: 2, stepScale: 1.15, volumeScale: 1.2, takeProfit: 2, stopLoss: 10,
  },
  {
    id: "trend_pullback", family: "trend", selectionWeight: 25, name: "Trend Pullback", posture: ["conservative", "balanced"], horizon: ["intraday", "swing"],
    description: "Requires a bullish moving-average structure while RSI shows a controlled pullback.",
    conditions: [
      { type: "moving_average", timeframe: "15Min", parameters: { average: "ema", fast: 9, slow: 21, operator: "above" } },
      { type: "rsi", timeframe: "15Min", parameters: { period: 14, operator: "below", value: 45 } },
    ], steps: 3, deviation: 2.5, stepScale: 1.1, volumeScale: 1.15, takeProfit: 3, stopLoss: 12,
  },
  {
    id: "opening_breakout", family: "breakout", selectionWeight: 15, name: "Opening Range Breakout", posture: ["balanced", "aggressive"], horizon: ["intraday"],
    description: "Enters only when price breaks the opening range with above-average volume.",
    conditions: [
      { type: "opening_range", timeframe: "5Min", parameters: { minutes: "15", operator: "above" } },
      { type: "relative_volume", timeframe: "5Min", parameters: { operator: "above", value: 1.5, lookback: 20 } },
    ], steps: 1, deviation: 3, stepScale: 1, volumeScale: 1, takeProfit: 3, stopLoss: 6,
  },
  {
    id: "bollinger_reversion", family: "mean_reversion", selectionWeight: 15, name: "Bollinger Reversion", posture: ["balanced", "aggressive"], horizon: ["intraday", "swing"],
    description: "Looks for price beyond the lower band, confirmed by elevated volatility before attempting a rebound trade.",
    conditions: [
      { type: "bollinger", timeframe: "15Min", parameters: { period: 20, deviations: 2, operator: "below_lower" } },
      { type: "atr", timeframe: "15Min", parameters: { period: 14, operator: "above", value: 1.5 } },
      { type: "relative_volume", timeframe: "15Min", parameters: { operator: "above", value: 1.15, lookback: 20 } },
    ], steps: 4, deviation: 2, stepScale: 1.2, volumeScale: 1.15, takeProfit: 2.5, stopLoss: 14,
  },
  {
    id: "gap_recovery", family: "experimental", selectionWeight: 5, name: "Gap Recovery", posture: ["balanced", "aggressive"], horizon: ["intraday"],
    description: "Looks for a moderate gap down followed by a move back above VWAP, avoiding blind entries at the open.",
    conditions: [
      { type: "gap", timeframe: "5Min", parameters: { operator: "down", value: 2 } },
      { type: "vwap", timeframe: "5Min", parameters: { operator: "above" } },
    ], steps: 2, deviation: 2.5, stepScale: 1.1, volumeScale: 1.1, takeProfit: 2.5, stopLoss: 8,
  },
  {
    id: "macd_volume", family: "breakout", selectionWeight: 20, name: "MACD Volume Confirmation", posture: ["balanced", "aggressive"], horizon: ["intraday", "swing"],
    description: "Combines a bullish MACD crossover with increased relative volume to reduce weak crossover signals.",
    conditions: [
      { type: "macd", timeframe: "15Min", parameters: { fast: 12, slow: 26, signal: 9, operator: "bullish" } },
      { type: "relative_volume", timeframe: "15Min", parameters: { operator: "above", value: 1.25, lookback: 20 } },
    ], steps: 2, deviation: 3, stepScale: 1.15, volumeScale: 1.1, takeProfit: 4, stopLoss: 10,
  },
];

const pick = (values) => values[Math.floor(Math.random() * values.length)];
function weightedPick(values, weightKey = "selectionWeight") { const total = values.reduce((sum, value) => sum + Number(value[weightKey] || 1), 0); let roll = Math.random() * total; return values.find((value) => (roll -= Number(value[weightKey] || 1)) <= 0) || values.at(-1); }
const liquidUniverses = new Map();
async function getLiquidUniverse(rankingMode = "sustained_volume") { if (!liquidUniverses.has(rankingMode)) liquidUniverses.set(rankingMode, await invoke("liquid-symbols", { rankingMode })); return liquidUniverses.get(rankingMode); }
const randomStep = (min, max, step) => Number((min + Math.floor(Math.random() * (Math.floor((max - min) / step) + 1)) * step).toFixed(4));

function randomizeCondition(condition) {
  const next = structuredClone(condition); const p = next.parameters; const changed = {};
  if (next.type === "rsi") { p.period = pick([10, 12, 14, 16, 18]); p.value = p.operator === "below" ? randomStep(27, 38, 1) : randomStep(52, 68, 1); changed.RSI = `${p.period}-period at ${p.value}`; }
  if (next.type === "moving_average") { const pair = pick([[5, 20], [8, 21], [9, 21], [10, 30], [12, 26], [20, 50]]); p.fast = pair[0]; p.slow = pair[1]; changed[`${p.average.toUpperCase()} pair`] = `${p.fast}/${p.slow}`; }
  if (next.type === "relative_volume") { p.value = randomStep(1.2, 2.2, .05); p.lookback = pick([10, 15, 20, 30]); changed["Relative volume"] = `${p.value}× over ${p.lookback} bars`; }
  if (next.type === "opening_range") { p.minutes = String(pick([5, 15, 30])); changed["Opening range"] = `${p.minutes} minutes`; }
  if (next.type === "bollinger") { p.period = pick([18, 20, 22]); p.deviations = randomStep(1.8, 2.4, .1); changed["Bollinger Bands"] = `${p.period} periods / ${p.deviations}σ`; }
  if (next.type === "atr") { p.period = pick([10, 14, 20]); p.value = randomStep(1.2, 2.5, .1); changed.ATR = `${p.period} periods / ${p.value}%`; }
  if (next.type === "gap") { p.value = randomStep(1.25, 4, .25); changed.Gap = `${p.value}%`; }
  return { condition: next, changed };
}

function varyConditionCount(conditions, bias, randomized) {
  const roll = Math.random(), target = roll < .15 ? 1 : roll < .75 ? 2 : 3;
  const confirmationTypes = new Set(["relative_volume", "vwap", "atr"]), primary = conditions.find((condition) => !confirmationTypes.has(condition.type)) || conditions[0];
  let selected = target === 1 ? [primary] : conditions.length > target ? [primary, ...conditions.filter((condition) => condition !== primary).sort(() => Math.random() - .5).slice(0, target - 1)] : [...conditions];
  const timeframe = primary?.timeframe || "15Min", additions = [
    { type: "relative_volume", timeframe, parameters: { operator: "above", value: 1.2, lookback: 20 } },
    { type: "moving_average", timeframe, parameters: { average: "ema", fast: 9, slow: 21, operator: bias === "bearish" ? "below" : "above" } },
    { type: "rsi", timeframe, parameters: { period: 14, operator: bias === "bearish" ? "below" : "above", value: bias === "bearish" ? 48 : 52 } },
  ];
  for (const addition of additions) {
    if (selected.length >= target) break;
    if (selected.some((condition) => condition.type === addition.type)) continue;
    const result = randomizeCondition(addition); selected.push(result.condition); Object.assign(randomized, result.changed);
  }
  randomized["Start-condition count"] = selected.length;
  randomized["Signal strictness"] = selected.length === 1 ? "single signal" : selected.length === 2 ? "signal + confirmation" : "strict confirmation";
  return selected;
}

function randomizedStockStrategy(template, posture = "balanced", horizon = "intraday", symbol = "SPY") {
  const next = structuredClone(template); const randomized = {};
  next.conditions = template.conditions.map((condition) => { const result = randomizeCondition(condition); Object.assign(randomized, result.changed); return result.condition; });
  next.conditions = varyConditionCount(next.conditions, "bullish", randomized);
  const profiles = { conservative: { steps: [1, 2], volume: [1, 1.08], atr: [.8, 1.6], reward: [1, 1.35], stop: [1.4, 1.8] }, balanced: { steps: [1, 3], volume: [1, 1.15], atr: [1, 2.1], reward: [1.15, 1.65], stop: [1.5, 2] }, aggressive: { steps: [1, 3], volume: [1, 1.2], atr: [1.3, 2.8], reward: [1.3, 2], stop: [1.6, 2.2] } };
  const profile = profiles[posture] || profiles.balanced, liquidEtf = ["SPY","QQQ","IWM","DIA","XLF","XLK","XLE","TLT","GLD","SLV","EEM","HYG"].includes(String(symbol).toUpperCase());
  const atrPct = randomStep(profile.atr[0], profile.atr[1] + (liquidEtf ? 0 : .4), .1), rewardMultiple = randomStep(profile.reward[0], profile.reward[1], .05), stopMultiple = randomStep(profile.stop[0], profile.stop[1], .05);
  next.steps = Math.floor(randomStep(profile.steps[0], profile.steps[1], 1)); next.stepScale = randomStep(1, 1.08, .02); next.volumeScale = randomStep(profile.volume[0], profile.volume[1], .01);
  next.takeProfit = Number(Math.max(.7, atrPct * rewardMultiple).toFixed(2)); next.stopLoss = Number(Math.max(2, atrPct * stopMultiple).toFixed(2));
  const spacingUnits = Array.from({ length: next.steps }, (_, index) => Math.pow(next.stepScale, index)).reduce((sum, value) => sum + value, 0); next.deviation = Number((next.stopLoss * randomStep(.5, .68, .02) / spacingUnits).toFixed(2));
  next.volatilityModel = { type: "atr_scaled_defaults", assumed_atr_pct: atrPct, profit_atr_multiple: rewardMultiple, stop_atr_multiple: stopMultiple };
  Object.assign(randomized, { "Strategy family": next.family.replaceAll("_", " "), "Risk profile": posture, "Time horizon": horizon, "Volatility assumption": `${atrPct}% ATR`, "Profit target": `${rewardMultiple} ATR / ${next.takeProfit}%`, "Protective stop": `${stopMultiple} ATR / ${next.stopLoss}%`, "Averaging orders": next.steps, "Initial spacing": `${next.deviation}%`, "Step scale": next.stepScale, "Order growth": `${next.volumeScale}×`, "Ticker adjustment": liquidEtf ? "liquid ETF" : "individual stock" });
  next.randomizedFields = randomized; next.generationId = crypto.randomUUID();
  return next;
}

function randomSchedule(strategy, risk) {
  const weights = Array.from({ length: strategy.steps + 1 }, (_, index) => Math.pow(strategy.volumeScale, index));
  const initial = risk / weights.reduce((sum, weight) => sum + weight, 0);
  let deviation = 0;
  return weights.map((weight, step) => {
    if (step) deviation += strategy.deviation * Math.pow(strategy.stepScale, step - 1);
    return { step, deviation, amount: Math.floor(initial * weight * 100) / 100 };
  });
}

async function autoBacktest(botId, marketDays = 5) {
  const end = new Date(); end.setUTCDate(end.getUTCDate() - 1); end.setUTCHours(23, 59, 0, 0); const start = new Date(end); start.setUTCDate(start.getUTCDate() - Math.ceil(Number(marketDays) * 1.6 + 10));
  return invoke("backtest-bot", { botId, start: start.toISOString(), end: end.toISOString(), marketDays: Number(marketDays) });
}

async function showRandomBotForm() {
  let universe; try { universe = await getLiquidUniverse(); } catch (error) { console.warn(error); universe = { symbols: ["SPY"] }; }
  $("#modal-content").innerHTML = `<form id="random-bot-form"><div class="modal-head"><div><h3>Generate a smarter random stock bot</h3><p>BotGarden pairs coherent signals with volatility-scaled exits and a bounded averaging schedule.</p></div><button type="button" class="icon-button" data-close-modal>×</button></div><div class="modal-body"><div class="callout">Strategy families are weighted toward pullbacks, trends, and confirmed breakouts. The allocation is capped, averaging stays inside the protective stop, and every generated choice is recorded. Paper results are still uncertain.</div><div class="form-grid"><label>Maximum allocation ($)<input name="risk" type="number" min="50" max="100000" step="10" value="500" required></label><label>Symbol<input name="symbol" value="SPY" maxlength="20" required></label><label>Asset class<select name="assetClass"><option value="equity">Stocks</option><option value="option">Stock options</option></select></label><label>Risk posture<select name="posture"><option value="conservative">Conservative</option><option value="balanced" selected>Balanced</option><option value="aggressive">Aggressive</option></select></label><label>Time horizon<select name="horizon"><option value="intraday" selected>Intraday</option><option value="swing">Swing</option></select></label><label>Trading session<select name="sessionPolicy"><option value="regular">Regular hours only</option><option value="extended">Include extended hours</option></select></label></div><div id="random-preview" class="random-preview"></div><p class="form-message" id="random-message"></p></div><div class="modal-foot"><button type="button" class="secondary" data-close-modal>Cancel</button><button type="button" class="secondary" id="reroll-bot">Try another</button><button class="primary" type="submit">Save this draft</button></div></form>`;
  modal.showModal();
  const form = $("#random-bot-form");
  form.elements.symbol.value = pick(universe.symbols);
  form.querySelector(".form-grid").insertAdjacentHTML("beforeend", `<label>Backtest market days<input name="backtestDays" type="number" min="1" max="60" value="5" required></label>`);
  const randomOptionChoice = form.querySelector('[name="assetClass"] option[value="option"]');
  randomOptionChoice.disabled = true;
  randomOptionChoice.textContent = "Stock options — contract selector coming next";
  let selected = null;
  const roll = () => {
    const data = new FormData(form); const posture = data.get("posture"); const horizon = data.get("horizon");
    const candidates = RANDOM_STRATEGIES.filter((strategy) => strategy.posture.includes(posture) && strategy.horizon.includes(horizon) && strategy.id !== selected?.id);
    selected = randomizedStockStrategy(weightedPick(candidates) || RANDOM_STRATEGIES[0], posture, horizon, data.get("symbol"));
    const risk = Number(data.get("risk")); const schedule = randomSchedule(selected, risk);
    $("#random-preview").innerHTML = `<span class="eyebrow">CURATED + BOUNDED RANDOMIZATION</span><h3>${selected.name}</h3><p>${selected.description}</p><div class="random-stats"><div><span>Conditions</span><strong>${selected.conditions.length} joined with AND</strong></div><div><span>Orders</span><strong>${schedule.length}</strong></div><div><span>Take profit</span><strong>${pct(selected.takeProfit)}</strong></div><div><span>Stop loss</span><strong>${pct(selected.stopLoss)}</strong></div></div><div class="subtle">${selected.conditions.map((condition) => conditionDefinition(condition.type)[1]).join(" + ")}</div><div class="randomized-list">${Object.entries(selected.randomizedFields).map(([key, value]) => `<span><b>${escapeHtml(key)}:</b> ${escapeHtml(value)}</span>`).join("")}</div>`;
  };
  $("#reroll-bot").addEventListener("click", () => { form.elements.symbol.value = pick(universe.symbols); roll(); });
  form.querySelectorAll("select").forEach((field) => field.addEventListener("change", roll));
  form.elements.symbol.addEventListener("change", roll);
  roll();
  form.addEventListener("submit", async (event) => {
    event.preventDefault(); const button = event.submitter; button.disabled = true;
    const data = new FormData(form); const risk = Number(data.get("risk")); const schedule = randomSchedule(selected, risk);
    const payload = { user_id: session.user.id, name: `${data.get("symbol").toUpperCase().trim()} ${selected.name}`, bot_type: "dca", status: "active", broker: "alpaca", environment: "paper", asset_class: data.get("assetClass"), symbol: data.get("symbol").toUpperCase().trim(), direction: "long", max_allocation: risk, max_active_trades: 1, start_condition: { operator: "AND", conditions: selected.conditions, generated_strategy: selected.id, generation_id: selected.generationId, randomized_fields: selected.randomizedFields, volatility_model: selected.volatilityModel, sizing_mode: "fixed" }, take_profit_pct: selected.takeProfit, stop_loss_pct: selected.stopLoss, cooldown_seconds: data.get("horizon") === "intraday" ? 1800 : 86400, session_policy: data.get("sessionPolicy") };
    const { data: bot, error } = await supabase.from("bg_bots").insert(payload).select().single();
    if (error) { $("#random-message").textContent = error.message; button.disabled = false; return; }
    const { error: stepError } = await supabase.from("bg_averaging_steps").insert(schedule.map((step) => ({ bot_id: bot.id, step_number: step.step, deviation_pct: step.deviation, order_amount: step.amount })));
    if (stepError) { $("#random-message").textContent = stepError.message; button.disabled = false; return; }
    button.textContent = `Backtesting ${data.get("backtestDays")} market days…`;
    try { await autoBacktest(bot.id, data.get("backtestDays")); } catch (error) { console.warn("Automatic backtest failed", error); }
    modal.close(); await loadDashboard();
  });
}

const OPTION_STRATEGIES = [
  {
    id: "bull_put_pullback", name: "Bull Put Pullback", family: "credit_spread", spreadType: "bull_put_credit", bias: "bullish",
    description: "Sells a put spread only while the broader trend is bullish and RSI shows a measured pullback.",
    conditions: [
      { type: "moving_average", timeframe: "15Min", parameters: { average: "ema", fast: 9, slow: 21, operator: "above" } },
      { type: "rsi", timeframe: "15Min", parameters: { period: 14, operator: "below", value: 45 } },
    ],
  },
  {
    id: "bull_put_breakout", name: "Bull Put Breakout", family: "credit_spread", spreadType: "bull_put_credit", bias: "bullish",
    description: "Requires an upside opening-range break with strong relative volume before selling downside premium.",
    conditions: [
      { type: "opening_range", timeframe: "5Min", parameters: { minutes: "15", operator: "above" } },
      { type: "relative_volume", timeframe: "5Min", parameters: { operator: "above", value: 1.5, lookback: 20 } },
    ],
  },
  {
    id: "bear_call_rally", name: "Bear Call Rally Fade", family: "credit_spread", spreadType: "bear_call_credit", bias: "bearish",
    description: "Waits for a bearish trend with an overextended RSI reading before selling an out-of-the-money call spread.",
    conditions: [
      { type: "moving_average", timeframe: "15Min", parameters: { average: "ema", fast: 9, slow: 21, operator: "below" } },
      { type: "rsi", timeframe: "15Min", parameters: { period: 14, operator: "above", value: 55 } },
    ],
  },
  {
    id: "bear_call_breakdown", name: "Bear Call Breakdown", family: "credit_spread", spreadType: "bear_call_credit", bias: "bearish",
    description: "Requires a downside opening-range break with strong relative volume before selling upside premium.",
    conditions: [
      { type: "opening_range", timeframe: "5Min", parameters: { minutes: "15", operator: "below" } },
      { type: "relative_volume", timeframe: "5Min", parameters: { operator: "above", value: 1.5, lookback: 20 } },
    ],
  },
  {
    id: "bull_call_momentum", name: "Bull Call Momentum", family: "debit_spread", spreadType: "bull_call_debit", bias: "bullish",
    description: "Buys a defined-risk call spread after bullish momentum and above-normal volume confirm each other.",
    conditions: [
      { type: "moving_average", timeframe: "15Min", parameters: { average: "ema", fast: 9, slow: 21, operator: "above" } },
      { type: "relative_volume", timeframe: "15Min", parameters: { operator: "above", value: 1.3, lookback: 20 } },
    ],
  },
  {
    id: "bear_put_momentum", name: "Bear Put Momentum", family: "debit_spread", spreadType: "bear_put_debit", bias: "bearish",
    description: "Buys a defined-risk put spread when bearish momentum is confirmed by relative volume.",
    conditions: [
      { type: "moving_average", timeframe: "15Min", parameters: { average: "ema", fast: 9, slow: 21, operator: "below" } },
      { type: "relative_volume", timeframe: "15Min", parameters: { operator: "above", value: 1.3, lookback: 20 } },
    ],
  },
  {
    id: "long_call_breakout", name: "Long Call Breakout", family: "long_option", spreadType: "long_call", bias: "bullish",
    description: "Buys a call only after an upside opening-range break with confirming volume.",
    conditions: [
      { type: "opening_range", timeframe: "5Min", parameters: { minutes: "15", operator: "above" } },
      { type: "relative_volume", timeframe: "5Min", parameters: { operator: "above", value: 1.5, lookback: 20 } },
    ],
  },
  {
    id: "long_put_breakdown", name: "Long Put Breakdown", family: "long_option", spreadType: "long_put", bias: "bearish",
    description: "Buys a put only after a downside opening-range break with confirming volume.",
    conditions: [
      { type: "opening_range", timeframe: "5Min", parameters: { minutes: "15", operator: "below" } },
      { type: "relative_volume", timeframe: "5Min", parameters: { operator: "above", value: 1.5, lookback: 20 } },
    ],
  },
];

function randomizedOptionStrategy(template, posture) {
  const next = structuredClone(template); const randomized = {};
  next.conditions = template.conditions.map((condition) => { const result = randomizeCondition(condition); Object.assign(randomized, result.changed); return result.condition; });
  next.conditions = varyConditionCount(next.conditions, template.bias, randomized);
  const bands = { conservative: [0.10, 0.15], balanced: [0.14, 0.20], aggressive: [0.20, 0.26] };
  const [minDelta, maxDelta] = bands[posture]; next.delta = randomStep(minDelta, maxDelta, .01);
  next.lossCloseMultiple = randomStep(1.5, 2.0, .25); next.posture = posture; next.generationId = crypto.randomUUID();
  Object.assign(randomized, { "Risk profile": posture, "Target delta": next.delta, "Loss-close multiple": `${next.lossCloseMultiple}× premium` });
  next.randomizedFields = randomized; return next;
}

async function showRandomOptionBotForm() {
  let universe; try { universe = await getLiquidUniverse(); } catch (error) { console.warn(error); universe = { optionSymbols: ["SPY"] }; }
  $("#modal-content").innerHTML = `<form id="random-option-form"><div class="modal-head"><div><h3>Generate a random option strategy</h3><p>Choose a strategy family, then get coherent randomized entry and exit rules.</p></div><button type="button" class="icon-button" data-close-modal>×</button></div><div class="modal-body"><div class="callout">Historical tests measure underlying entry signals and market context; they do not estimate option P&amp;L.</div><div class="form-grid"><label>Strategy family<select name="strategyFamily"><option value="credit_spread" selected>Credit spread (default)</option><option value="debit_spread">Debit spread</option><option value="long_option">Long call or put</option></select></label><label>Maximum risk ($)<input name="risk" type="number" min="25" max="100000" step="25" value="500" required></label><label>Underlying symbol<input name="symbol" value="SPY" maxlength="10" required></label><label>Market bias<select name="bias"><option value="either">Surprise me</option><option value="bullish">Bullish</option><option value="bearish">Bearish</option></select></label><label>Risk posture<select name="posture"><option value="conservative">Conservative</option><option value="balanced" selected>Balanced</option><option value="aggressive">Aggressive</option></select></label><label>Expiration window<select name="dte"><option value="30,45" selected>30–45 days</option><option value="21,35">21–35 days</option><option value="45,60">45–60 days</option></select></label><label id="option-width-label">Spread width ($)<select name="width"><option value="2.5">$2.50</option><option value="5" selected>$5.00</option><option value="10">$10.00</option></select></label><label><span id="option-premium-label">Minimum entry credit ($)</span><input name="premium" type="number" min="0.05" step="0.05" value="1.00" required></label><label>Maximum bid/ask spread (%)<input name="maxSpread" type="number" min="1" max="100" step="1" value="15" required></label><label>Close profit at (%)<input name="profitClose" type="number" min="5" max="95" value="50" required></label><label>Exit before expiration (DTE)<input name="exitDte" type="number" min="0" max="30" value="7" required></label></div><div id="option-preview" class="random-preview"></div><p class="form-message" id="option-message"></p></div><div class="modal-foot"><button type="button" class="secondary" data-close-modal>Cancel</button><button type="button" class="secondary" id="reroll-option">Try another</button><button class="primary" id="save-option" type="submit">Save this draft</button></div></form>`;
  modal.showModal();
  const form = $("#random-option-form"); const creditEtfs = ["SPY","QQQ","IWM","DIA","XLF","XLK","XLE","TLT","GLD","SLV","EEM","HYG"].filter((symbol) => universe.optionSymbols?.includes(symbol)); form.elements.symbol.value = pick(creditEtfs.length ? creditEtfs : (universe.optionSymbols?.length ? universe.optionSymbols : ["SPY"])); form.elements.dte.insertAdjacentHTML("afterbegin", `<option value="30,60">30–60 days</option>`); form.elements.dte.value = "30,60"; form.elements.profitClose.value = "40"; form.elements.exitDte.value = "21"; form.querySelector(".form-grid").insertAdjacentHTML("beforeend", `<label>Signal-test market days<input name="backtestDays" type="number" min="1" max="60" value="5" required></label>`); let selected = null;
  const render = (reroll = false) => {
    const data = new FormData(form); const bias = data.get("bias"); const family = data.get("strategyFamily");
    const candidates = OPTION_STRATEGIES.filter((strategy) => strategy.family === family && (bias === "either" || strategy.bias === bias) && (!reroll || strategy.id !== selected?.id));
    const posture = data.get("posture");
    if (!selected || reroll || selected.family !== family || selected.posture !== posture || (bias !== "either" && selected.bias !== bias)) selected = randomizedOptionStrategy(candidates[Math.floor(Math.random() * candidates.length)] || OPTION_STRATEGIES.find((strategy) => strategy.family === family) || OPTION_STRATEGIES[0], posture);
    const risk = Number(data.get("risk")); const width = family === "long_option" ? 0 : Number(data.get("width")); const premium = Number(data.get("premium"));
    const riskPerContract = Math.max(0, (family === "credit_spread" ? width - premium : premium) * 100); const contracts = riskPerContract ? Math.floor(risk / riskPerContract) : 0; const totalRisk = contracts * riskPerContract;
    const delta = selected.delta;
    const valid = premium > 0 && (family === "long_option" || premium < width) && contracts >= 1;
    form.elements.width.disabled = family === "long_option"; $("#option-width-label").style.opacity = family === "long_option" ? ".45" : "1"; $("#option-premium-label").textContent = family === "credit_spread" ? "Minimum entry credit ($)" : "Maximum entry debit ($)";
    $("#save-option").disabled = !valid;
    $("#option-message").textContent = valid ? "" : premium >= width && family !== "long_option" ? "Entry premium must be less than the spread width." : `This budget is below the estimated ${money(riskPerContract)} risk of one contract.`;
    const structures = { bull_put_credit: "Bull put credit spread", bear_call_credit: "Bear call credit spread", bull_call_debit: "Bull call debit spread", bear_put_debit: "Bear put debit spread", long_call: "Long call", long_put: "Long put" }; const maxProfit = family === "credit_spread" ? money(contracts * premium * 100) : family === "debit_spread" ? money(contracts * (width - premium) * 100) : "Open-ended";
    $("#option-preview").innerHTML = `<span class="eyebrow">DEFINED RISK + BOUNDED RANDOMIZATION</span><h3>${selected.name}</h3><p>${selected.description}</p><div class="random-stats"><div><span>Target delta</span><strong>${delta.toFixed(2)}</strong></div><div><span>Contracts</span><strong>${contracts || "—"}</strong></div><div><span>Estimated max loss</span><strong>${valid ? money(totalRisk) : "—"}</strong></div><div><span>Maximum profit</span><strong>${valid ? maxProfit : "—"}</strong></div></div><div class="subtle">${structures[selected.spreadType]} · ${selected.conditions.map((condition) => conditionDefinition(condition.type)[1]).join(" + ")}</div><div class="randomized-list">${Object.entries(selected.randomizedFields).map(([key, value]) => `<span><b>${escapeHtml(key)}:</b> ${escapeHtml(value)}</span>`).join("")}</div>`;
    return { family, risk, width, premium, contracts, totalRisk, delta };
  };
  $("#reroll-option").addEventListener("click", () => { form.elements.symbol.value = pick(universe.optionSymbols?.length ? universe.optionSymbols : ["SPY"]); render(true); });
  form.addEventListener("input", () => render(false)); render(true);
  form.addEventListener("submit", async (event) => {
    event.preventDefault(); const button = event.submitter; button.disabled = true; const values = render(false); const data = new FormData(form);
    const [minDte, maxDte] = String(data.get("dte")).split(",").map(Number); const symbol = String(data.get("symbol")).toUpperCase().trim();
    const payload = { user_id: session.user.id, name: `${symbol} ${selected.name}`, bot_type: "option_strategy", status: "active", broker: "alpaca", environment: "paper", asset_class: "option", symbol, direction: selected.bias === "bullish" ? "long" : "short", max_allocation: values.totalRisk, max_active_trades: 1, start_condition: { operator: "AND", conditions: selected.conditions, generated_strategy: selected.id, generation_id: selected.generationId, randomized_fields: selected.randomizedFields }, take_profit_pct: Number(data.get("profitClose")), stop_loss_pct: null, cooldown_seconds: 86400, session_policy: "regular" };
    const { data: bot, error } = await supabase.from("bg_bots").insert(payload).select().single();
    if (error) { $("#option-message").textContent = error.message; button.disabled = false; return; }
    const { error: spreadError } = await supabase.from("bg_option_spreads").insert({ bot_id: bot.id, spread_type: selected.spreadType, strategy_family: values.family, premium_type: values.family === "credit_spread" ? "credit" : "debit", min_dte: minDte, max_dte: maxDte, short_delta_target: values.delta, target_width: values.width, minimum_credit: values.premium, target_premium: values.premium, max_bid_ask_pct: Number(data.get("maxSpread")), contracts: values.contracts, max_risk: values.totalRisk, profit_close_pct: Number(data.get("profitClose")), loss_close_multiple: selected.lossCloseMultiple, exit_dte: Number(data.get("exitDte")) });
    if (spreadError) { await supabase.from("bg_bots").delete().eq("id", bot.id); $("#option-message").textContent = spreadError.message; button.disabled = false; return; }
    button.textContent = `Testing ${data.get("backtestDays")} market days…`;
    try { await autoBacktest(bot.id, data.get("backtestDays")); } catch (error) { console.warn("Automatic backtest failed", error); }
    modal.close(); await loadDashboard();
  });
}

async function createBulkStockBot(symbols, rankingMode = "sustained_volume") {
  const postureRoll = Math.random(), posture = postureRoll < .25 ? "conservative" : postureRoll < .95 ? "balanced" : "aggressive";
  const candidates = RANDOM_STRATEGIES.filter((strategy) => strategy.posture.includes(posture) && strategy.horizon.includes("intraday")), symbol = pick(symbols);
  const selected = randomizedStockStrategy(weightedPick(candidates), posture, "intraday", symbol); const risk = 500; const schedule = randomSchedule(selected, risk);
  const { data: bot, error } = await supabase.from("bg_bots").insert({ user_id: session.user.id, name: `${symbol} ${selected.name}`, bot_type: "dca", status: "active", broker: "alpaca", environment: "paper", asset_class: "equity", symbol, direction: "long", max_allocation: risk, max_active_trades: 1, start_condition: { operator: "AND", conditions: selected.conditions, generated_strategy: selected.id, generation_id: selected.generationId, randomized_fields: { ...selected.randomizedFields, "Ticker universe": rankingMode.replaceAll("_", " ") }, volatility_model: selected.volatilityModel, sizing_mode: "fixed", bulk_generated: true }, take_profit_pct: selected.takeProfit, stop_loss_pct: selected.stopLoss, cooldown_seconds: 1800, session_policy: "regular" }).select().single();
  if (error) throw error;
  const { error: stepError } = await supabase.from("bg_averaging_steps").insert(schedule.map((step) => ({ bot_id: bot.id, step_number: step.step, deviation_pct: step.deviation, order_amount: step.amount })));
  if (stepError) { await supabase.from("bg_bots").delete().eq("id", bot.id); throw stepError; }
  return bot;
}

async function createBulkOptionBot(index, symbols, rankingMode = "sustained_volume") {
  const families = ["credit_spread", "credit_spread", "credit_spread", "debit_spread", "long_option"];
  const family = families[index % families.length]; const bias = Math.random() < .5 ? "bullish" : "bearish";
  const selected = randomizedOptionStrategy(pick(OPTION_STRATEGIES.filter((strategy) => strategy.family === family && strategy.bias === bias)), "balanced");
  const risk = 500, width = family === "long_option" ? 0 : 5, premium = family === "credit_spread" ? randomStep(1, 1.5, .05) : family === "debit_spread" ? randomStep(1.5, 2.5, .05) : randomStep(2.5, 4.5, .05);
  const saferEtfs = ["SPY","QQQ","IWM","DIA","XLF","XLK","XLE","TLT","GLD","SLV","EEM","HYG"].filter((symbol) => symbols.includes(symbol)), symbolPool = family === "credit_spread" && saferEtfs.length ? saferEtfs : symbols;
  const riskPerContract = (family === "credit_spread" ? width - premium : premium) * 100, contracts = Math.max(1, Math.floor(risk / riskPerContract)), totalRisk = contracts * riskPerContract, symbol = pick(symbolPool);
  const { data: bot, error } = await supabase.from("bg_bots").insert({ user_id: session.user.id, name: `${symbol} ${selected.name}`, bot_type: "option_strategy", status: "active", broker: "alpaca", environment: "paper", asset_class: "option", symbol, direction: bias === "bullish" ? "long" : "short", max_allocation: totalRisk, max_active_trades: 1, start_condition: { operator: "AND", conditions: selected.conditions, generated_strategy: selected.id, generation_id: selected.generationId, randomized_fields: { ...selected.randomizedFields, "Strategy family": family.replaceAll("_", " "), "Target premium": money(premium), "Ticker universe": rankingMode.replaceAll("_", " ") }, bulk_generated: true }, take_profit_pct: 50, stop_loss_pct: null, cooldown_seconds: 86400, session_policy: "regular" }).select().single();
  if (error) throw error;
  const { error: spreadError } = await supabase.from("bg_option_spreads").insert({ bot_id: bot.id, spread_type: selected.spreadType, strategy_family: family, premium_type: family === "credit_spread" ? "credit" : "debit", min_dte: 30, max_dte: 60, short_delta_target: selected.delta, target_width: width, minimum_credit: premium, target_premium: premium, max_bid_ask_pct: 15, contracts, max_risk: totalRisk, profit_close_pct: 40, loss_close_multiple: selected.lossCloseMultiple, exit_dte: 21 });
  if (spreadError) { await supabase.from("bg_bots").delete().eq("id", bot.id); throw spreadError; }
  return bot;
}

function showBulkRandomForm() {
  $("#modal-content").innerHTML = `<div class="modal-head"><div><h3 id="bulk-title">Create 25 random bots</h3><p id="bulk-description">15 stock bots and 10 mixed option strategies, each tested for your selected number of market days.</p></div><button type="button" class="icon-button" data-close-modal>×</button></div><div class="modal-body"><div class="callout">Tickers are selected from the strongest qualifying names within Alpaca's current 100 most active. A price and dollar-volume safety proxy filters penny stocks and thin small-cap behavior; it is not a verified market-cap screen.</div><fieldset class="universe-picker"><legend>Ticker selection</legend><label><input type="radio" name="ranking-mode" value="sustained_volume" checked><span><b>Sustained volume</b><small>Strong share volume across the latest week</small></span></label><label><input type="radio" name="ranking-mode" value="today_volume"><span><b>Today's volume</b><small>Most heavily traded in the latest session</small></span></label><label><input type="radio" name="ranking-mode" value="relative_volume"><span><b>Relative volume</b><small>Largest volume surge versus its 20-day norm</small></span></label><label><input type="radio" name="ranking-mode" value="active_movers"><span><b>Active movers</b><small>Largest up or down move with real dollar volume</small></span></label></fieldset><div class="form-grid bulk-config"><label>Stock bots<input id="bulk-stock-count" type="number" min="0" max="100" step="1" value="15" required></label><label>Option bots<input id="bulk-option-count" type="number" min="0" max="100" step="1" value="10" required></label></div><div class="bulk-summary"><div><strong>15</strong><span>Random stock bots</span></div><div><strong>10</strong><span>Mixed option strategies</span></div><div><strong>5d</strong><span>Automatic coverage each</span></div></div><label class="bulk-days">Backtest market days per bot<input id="bulk-backtest-days" type="number" min="1" max="60" value="5" required></label><div id="bulk-progress" class="bulk-progress"><span></span><strong>Ready to create</strong></div><p class="form-message" id="bulk-message"></p></div><div class="modal-foot"><button class="secondary" data-close-modal>Cancel</button><button class="primary" id="confirm-bulk">Create and test 25</button></div>`;
  modal.showModal();
  const refreshCounts = () => { const stockCount = Math.min(100, Math.max(0, Math.floor(Number($("#bulk-stock-count").value) || 0))), optionCount = Math.min(100, Math.max(0, Math.floor(Number($("#bulk-option-count").value) || 0))), totalCount = stockCount + optionCount; $(".bulk-summary div:nth-child(1) strong").textContent = stockCount; $(".bulk-summary div:nth-child(2) strong").textContent = optionCount; $("#bulk-title").textContent = `Create ${totalCount} random bot${totalCount === 1 ? "" : "s"}`; $("#bulk-description").textContent = `${stockCount} stock bot${stockCount === 1 ? "" : "s"} and ${optionCount} mixed option ${optionCount === 1 ? "strategy" : "strategies"}, each tested for your selected number of market days.`; $("#confirm-bulk").textContent = `Create and test ${totalCount}`; $("#confirm-bulk").disabled = totalCount === 0; return { stockCount, optionCount, totalCount }; };
  [$("#bulk-stock-count"), $("#bulk-option-count")].forEach((input) => input.addEventListener("input", refreshCounts));
  const coverageValue = $(".bulk-summary div:nth-child(3) strong"); $("#bulk-backtest-days").addEventListener("input", (event) => coverageValue.textContent = `${event.target.value || 5}d`);
  $("#confirm-bulk").addEventListener("click", async (event) => {
    const { stockCount, totalCount } = refreshCounts(); if (!totalCount) return;
    const button = event.currentTarget, rankingMode = document.querySelector('[name="ranking-mode"]:checked').value; button.disabled = true; let completed = 0, failures = 0;
    $("#modal-content").querySelectorAll("input").forEach((input) => input.disabled = true); $("#bulk-progress strong").textContent = "Ranking the current liquid universe…";
    let universe; try { universe = await getLiquidUniverse(rankingMode); } catch (error) { universe = { symbols: ["SPY"], optionSymbols: ["SPY"] }; }
    const update = (message) => { const progress = completed / totalCount * 100; $("#bulk-progress span").style.width = `${progress}%`; $("#bulk-progress strong").textContent = message; };
    for (let index = 0; index < totalCount; index++) {
      try {
        update(`Creating ${index < stockCount ? "stock" : "option"} bot ${index + 1} of ${totalCount}…`);
        const bot = index < stockCount ? await createBulkStockBot(universe.symbols, rankingMode) : await createBulkOptionBot(index - stockCount, universe.optionSymbols?.length ? universe.optionSymbols : ["SPY"], rankingMode);
        update(`Backtesting ${bot.name}…`); await autoBacktest(bot.id, Number($("#bulk-backtest-days").value));
      } catch (error) { failures++; console.warn("Bulk bot creation failed", error); }
      completed++; update(`${completed} of ${totalCount} complete`);
    }
    await loadDashboard();
    if (failures) { $("#bulk-message").textContent = `${totalCount - failures} bots completed; ${failures} failed. Close this window and retry to add replacements.`; button.textContent = "Completed with warnings"; button.disabled = true; }
    else { modal.close(); }
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
    const payload = { user_id: session.user.id, name: data.get("name"), bot_type: "dca", status: "active", broker: "alpaca", environment: "paper", asset_class: data.get("assetClass"), symbol: data.get("symbol").toUpperCase().trim(), direction: data.get("direction"), max_allocation: schedule.at(-1).cumulative, max_active_trades: Number(data.get("maxActiveTrades")), start_condition: { ...readConditions(form), sizing_mode: data.get("sizingMode") }, take_profit_pct: Number(data.get("takeProfit")), stop_loss_pct: Number(data.get("stopLoss")) || null, cooldown_seconds: Number(data.get("cooldownMinutes")) * 60, session_policy: data.get("sessionPolicy") };
    const { data: bot, error } = await supabase.from("bg_bots").insert(payload).select().single();
    if (error) { $("#bot-message").textContent = error.message; button.disabled = false; return; }
    const rows = schedule.map((s) => ({ bot_id: bot.id, step_number: s.step, deviation_pct: s.deviation, order_amount: s.amount }));
    const { error: stepError } = await supabase.from("bg_averaging_steps").insert(rows);
    if (stepError) { $("#bot-message").textContent = stepError.message; button.disabled = false; return; }
    modal.close(); await loadDashboard();
  });
}

boot();
