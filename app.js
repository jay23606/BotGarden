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
let paperPerformance = new Map();
let paperPerformanceMeta = null;
let currentView = "dashboard";
let activityFilter = "equity";
let securitiesFilter = "equity";
let deferredInstallPrompt = null;
let batchBacktestRunning = false;

function showPwaNotice(message, action = "") {
  let notice = document.querySelector(".pwa-notice"); if (!notice) { notice = document.createElement("div"); notice.className = "pwa-notice"; document.body.append(notice); }
  notice.innerHTML = `<span>${escapeHtml(message)}</span>${action ? `<button class="secondary" data-pwa-action="${action}">${action === "reload" ? "Reload" : "Install"}</button>` : ""}<button class="icon-button" data-dismiss-pwa aria-label="Dismiss">×</button>`;
}

window.addEventListener("beforeinstallprompt", (event) => { event.preventDefault(); deferredInstallPrompt = event; showPwaNotice("BotGarden is ready to install as an app.", "install"); });
window.addEventListener("appinstalled", () => { deferredInstallPrompt = null; document.querySelector(".pwa-notice")?.remove(); });
if ("serviceWorker" in navigator) window.addEventListener("load", async () => { try { const registration = await navigator.serviceWorker.register("./service-worker.js", { scope: "./" }); registration.addEventListener("updatefound", () => { const worker = registration.installing; worker?.addEventListener("statechange", () => { if (worker.state === "installed" && navigator.serviceWorker.controller) showPwaNotice("A new BotGarden version is ready.", "reload"); }); }); } catch (error) { console.warn("PWA registration failed", error); } });

async function requestPwaInstall() { if (!deferredInstallPrompt) return showPwaNotice("Use your browser menu and choose Install app, or on iPhone choose Add to Home Screen and enable Open as Web App."); await deferredInstallPrompt.prompt(); await deferredInstallPrompt.userChoice; deferredInstallPrompt = null; }

if (!configured) $("#setup-banner").classList.remove("hidden");

function setSession(next) {
  session = next;
  authView.classList.toggle("hidden", !!session);
  appView.classList.toggle("hidden", !session);
  if (session) switchView("dashboard");
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
$("#stock-strategy").addEventListener("click", showStockStrategyForm);
$("#random-option-bot").addEventListener("click", showRandomOptionBotForm);
$("#random-ten").addEventListener("click", showBulkRandomForm);
$("#prune-bots").addEventListener("click", () => pruneUnderperformingBots("securities"));
document.addEventListener("click", (event) => {
  const nav = event.target.closest("[data-view]");
  if (nav) switchView(nav.dataset.view);
  if (event.target.closest("[data-new-bot]")) showBotForm();
  if (event.target.closest("[data-new-crypto]")) showCryptoGridForm();
  if (event.target.closest("[data-new-crypto-batch]")) showCryptoBatchFormV3();
  if (event.target.closest("[data-prune-crypto]")) pruneUnderperformingBots("crypto");
  const cryptoChild=event.target.closest("[data-crypto-child]");if(cryptoChild)createCryptoChild(cryptoChild.dataset.cryptoChild,cryptoChild);
  const activityTab=event.target.closest("[data-activity-filter]");if(activityTab){activityFilter=activityTab.dataset.activityFilter;document.querySelectorAll("[data-activity-filter]").forEach(button=>button.classList.toggle("active",button.dataset.activityFilter===activityFilter));loadActivity();}
  const securitiesTab=event.target.closest("[data-securities-filter]");if(securitiesTab){securitiesFilter=securitiesTab.dataset.securitiesFilter;renderSecuritiesWorkspace();}
  const closePosition=event.target.closest("[data-close-position]");if(closePosition)closeMarketPosition(closePosition.dataset.closePosition,closePosition);
  const cancelOrder=event.target.closest("[data-cancel-order]");if(cancelOrder)cancelPendingOrder(cancelOrder.dataset.cancelOrder,cancelOrder);
  const closeUnmanaged=event.target.closest("[data-close-unmanaged-all]");if(closeUnmanaged)closeAllUnmanagedPositions(closeUnmanaged);
  const cancelUnmanaged=event.target.closest("[data-cancel-unmanaged-all]");if(cancelUnmanaged)cancelAllUnmanagedOrders(cancelUnmanaged);
  if (event.target.closest("[data-connect]")) showConnectionForm();
  if (event.target.closest('[data-pwa-action="install"]') || event.target.closest("[data-install-pwa]")) requestPwaInstall();
  if (event.target.closest('[data-pwa-action="reload"]')) location.reload();
  if (event.target.closest("[data-dismiss-pwa]")) event.target.closest(".pwa-notice")?.remove();
  const operationsControl = event.target.closest("[data-operations-control]"); if (operationsControl) setOperationsControl(operationsControl.dataset.operationsControl, operationsControl);
  const details = event.target.closest("[data-bot-details]"); if (details) showBotDetails(details.dataset.botDetails);
  const backtest = event.target.closest("[data-backtest]"); if (backtest) showBacktestForm(backtest.dataset.backtest);
  const backtestAll = event.target.closest("[data-backtest-all]"); if (backtestAll) backtestAllBots30Days(backtestAll);
  const child = event.target.closest("[data-child-bot]"); if (child) createRandomChild(child.dataset.childBot, child);
  const toggle = event.target.closest("[data-toggle-bot]"); if (toggle) toggleBot(toggle.dataset.toggleBot);
  const remove = event.target.closest("[data-delete-bot]"); if (remove) deleteBot(remove.dataset.deleteBot, remove);
  if (event.target.closest("[data-close-modal]")) modal.close();
});

async function getConnection() {
  try { const result = await invoke("alpaca-connection", { action: "status" }); return result.connected ? result.connection : null; }
  catch (error) { console.warn("Unable to read saved Alpaca connection status", error); return null; }
}

function renderEquityHistory(history = []) {
  if (history.length < 2) return `<div class="empty compact"><strong>Equity history will appear after Alpaca has at least two daily observations.</strong></div>`;
  const values = history.map((point) => Number(point.equity)), width = 900, height = 180, pad = 8;
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const points = values.map((value, index) => `${(index / (values.length - 1) * width).toFixed(1)},${(height - pad - (value - min) / span * (height - pad * 2)).toFixed(1)}`);
  const first = new Date(Number(history[0].timestamp) * 1000), last = new Date(Number(history.at(-1).timestamp) * 1000), change = values.at(-1) - values[0], changePct = values[0] ? change / values[0] * 100 : 0;
  return `<div class="card equity-panel"><svg class="equity-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Paper equity over the last 30 days"><line class="grid" x1="0" y1="${height / 2}" x2="${width}" y2="${height / 2}"/><polygon class="area" points="0,${height} ${points.join(" ")} ${width},${height}"/><polyline class="line" points="${points.join(" ")}"/></svg><div class="equity-chart-labels"><span>${first.toLocaleDateString()}</span><strong class="${change > 0 ? "profit" : change < 0 ? "loss" : ""}">${change >= 0 ? "+" : ""}${money(change)} · ${changePct >= 0 ? "+" : ""}${pct(changePct)}</strong><span>${last.toLocaleDateString()}</span></div></div>`;
}

function renderRiskHealth(account, positions = []) {
  if (!account) return `<div class="card risk-health"><div class="subtle">Connect Alpaca to calculate portfolio-level risk indicators.</div></div>`;
  const equity = Number(account.equity || 0), exposure = positions.reduce((sum, position) => sum + Math.abs(Number(position.market_value || 0)), 0), exposurePct = equity ? exposure / equity * 100 : 0;
  const largest = positions.reduce((current, position) => Math.abs(Number(position.market_value || 0)) > Math.abs(Number(current?.market_value || 0)) ? position : current, null), concentrationPct = equity && largest ? Math.abs(Number(largest.market_value)) / equity * 100 : 0;
  const dailyPct = account.last_equity ? (Number(account.equity) / Number(account.last_equity) - 1) * 100 : 0;
  const row = (label, value, level, note) => `<div class="risk-health-row"><strong>${label}</strong><span class="risk-badge ${level}">${value}</span><span>${note}</span></div>`;
  return `<div class="card risk-health">${row("Total gross exposure", pct(exposurePct), exposurePct >= 100 ? "danger" : exposurePct >= 75 ? "warning" : "", exposurePct >= 100 ? "At or above account equity; new exposure deserves review." : exposurePct >= 75 ? "Portfolio utilization is elevated." : "Exposure is within a moderate utilization band.")}${row("Largest position", largest ? `${escapeHtml(largest.symbol)} · ${pct(concentrationPct)}` : "None", concentrationPct >= 30 ? "danger" : concentrationPct >= 20 ? "warning" : "", concentrationPct >= 30 ? "A single position represents substantial account concentration." : concentrationPct >= 20 ? "Single-symbol concentration is elevated." : "No position exceeds the 20% attention threshold.")}${row("Today's equity move", `${dailyPct >= 0 ? "+" : ""}${pct(dailyPct)}`, dailyPct <= -5 ? "danger" : dailyPct <= -3 ? "warning" : "", dailyPct <= -5 ? "Consider pausing new entries and reviewing open risk." : dailyPct <= -3 ? "Daily drawdown has crossed the 3% attention threshold." : "No account-level drawdown alert is active.")}</div>`;
}

function workerHealthBlock(operational = {}) {
  const expected = { "entry-runner": 12, "risk-monitor": 3 }, labels = { "entry-runner": "5-minute entry runner", "risk-monitor": "1-minute risk monitor" }, rows = Object.keys(expected).map((mode) => { const beat = (operational.health || []).find((item) => item.worker_mode === mode), age = beat?.completed_at ? (Date.now() - new Date(beat.completed_at).valueOf()) / 60000 : Infinity, healthy = age <= expected[mode] && beat.status !== "error", state = !beat ? "No heartbeat" : healthy ? "Healthy" : `Stale · ${Math.floor(age)}m ago`; return `<div class="worker-health-row"><div><strong>${labels[mode]}</strong><span>${beat?.completed_at ? `Last completed ${new Date(beat.completed_at).toLocaleString()}` : "Waiting for the first completed run"}</span></div><b class="${healthy ? "profit" : "loss"}">${state}</b></div>`; }).join("");
  return `<div class="card worker-health"><div class="section-head compact-head"><h3>Scheduled-worker health</h3><span class="status ${operational.entries_paused ? "paused" : ""}">${operational.entries_paused ? "ENTRIES PAUSED" : "ENTRIES ENABLED"}</span></div>${rows}</div>`;
}

function renderActionCenter(operational = {}) {
  const actions = [], add = (priority, tone, title, detail, action = "") => actions.push({ priority, tone, title, detail, action });
  if (operational.entries_paused) add(100, "warning", "New entries are globally paused", "Risk exits continue, but no bot can submit a new entry until you resume them.", `<button class="secondary" data-view="settings">Review controls</button>`);
  const expected = { "entry-runner": 12, "risk-monitor": 3 }; Object.entries(expected).forEach(([mode, minutes]) => { const beat = (operational.health || []).find((item) => item.worker_mode === mode), age = beat?.completed_at ? (Date.now() - new Date(beat.completed_at).valueOf()) / 60000 : Infinity; if (age > minutes) add(95, "danger", `${mode === "entry-runner" ? "Entry runner" : "Risk monitor"} needs attention`, beat ? `Last completed ${Math.floor(age)} minutes ago.` : "No completed heartbeat has been recorded yet.", `<button class="secondary" data-view="settings">View health</button>`); });
  const unattributed = Number(paperPerformanceMeta?.unattributed_fill_count || 0); if (unattributed) add(90, "danger", `${unattributed} unattributed Alpaca fill${unattributed === 1 ? "" : "s"}`, "Resolve attribution before relying on bot-level paper P&L.", `<button class="secondary" data-view="activity">Review Activity</button>`);
  bots.filter((bot) => botMaturity(bot).id === "degraded").slice(0, 3).forEach((bot) => add(85, "danger", `Review degraded bot: ${bot.name}`, botMaturity(bot).note, `<button class="secondary" data-bot-details="${bot.id}">Inspect bot</button>`));
  bots.filter((bot) => ["candidate", "proven"].includes(botMaturity(bot).id) && bot.status !== "active").slice(0, 3).forEach((bot) => add(70, "positive", `${bot.name} is ${botMaturity(bot).label.toLowerCase()} but OFF`, "Review its evidence and decide whether to resume controlled paper observation.", `<button class="secondary" data-bot-details="${bot.id}">Review evidence</button>`));
  bots.filter((bot) => botMaturity(bot).id === "experimental" && botConfidence(bot).coverageDays < 10).sort((a,b)=>botConfidence(b).score-botConfidence(a).score).slice(0, 3).forEach((bot) => { const confidence = botConfidence(bot), needed = Math.max(1, 10 - confidence.coverageDays); add(40, "", `${bot.name} needs broader history`, `Test at least ${needed} additional unique market day${needed === 1 ? "" : "s"} before historical validation.`, `<button class="secondary" data-backtest="${bot.id}">Add coverage</button>`); });
  actions.sort((a,b)=>b.priority-a.priority); const visible = actions.slice(0, 8);
  return `<section class="today-center"><div class="section-head"><div><span class="eyebrow">TODAY</span><h3>Recommended next actions</h3></div><span class="subtle">Advisory only · highest priority first</span></div>${visible.length ? `<div class="action-grid">${visible.map((item)=>`<article class="action-item ${item.tone}"><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.detail)}</p></div>${item.action}</article>`).join("")}</div>` : `<div class="card all-clear"><strong>No urgent actions</strong><span>Workers, attribution, evidence stages, and paper controls currently look orderly.</span></div>`}</section>`;
}

function renderOverlapMap() {
  const clusters = [], totalAllocation = bots.reduce((sum, bot) => sum + Number(bot.max_allocation || 0), 0), addCluster = (kind, name, members, note) => { if (members.length > 1) clusters.push({ kind, name, members, note }); }, by = (key) => bots.reduce((map, bot) => { const value = key(bot); if (!value) return map; map.set(value, [...(map.get(value) || []), bot]); return map; }, new Map());
  by((bot)=>bot.symbol).forEach((members,name)=>addCluster("Shared symbol",name,members,"These bots can stack exposure to the same underlying."));
  by((bot)=>bot.start_condition?.conditions?.find((condition)=>["relative_strength","market_regime"].includes(condition.type))?.parameters?.benchmark).forEach((members,name)=>{if(members.length>=3)addCluster("Shared benchmark",name,members,"Signals depend on the same broad-market reference and may react together.");});
  by((bot)=>bot.start_condition?.generated_strategy).forEach((members,name)=>{if(members.length>=5)addCluster("Crowded family",String(name).replaceAll("_"," "),members,"Many candidates share the same strategy thesis; confidence applies a selection penalty while evidence is short.");});
  const directional = bots.filter((bot)=>bot.direction==="long"); if (directional.length >= 5 && directional.length / Math.max(1,bots.length) >= .75) clusters.push({kind:"Directional concentration",name:"Long bias",members:directional,note:`${directional.length} of ${bots.length} bots are long-biased.`});
  clusters.forEach((cluster) => { const active = cluster.members.filter((bot)=>bot.status==="active").length, allocation = cluster.members.reduce((sum,bot)=>sum+Number(bot.max_allocation||0),0), negative = cluster.members.filter((bot)=>Number(paperPerformance.get(bot.id)?.total_pnl||0)<0).length; cluster.active=active; cluster.allocation=allocation; cluster.score=Math.round(Math.min(100,Math.min(40,(cluster.members.length-1)*10)+active/cluster.members.length*20+(totalAllocation?allocation/totalAllocation*30:0)+negative/cluster.members.length*10)); cluster.level=cluster.score>=65?"High":cluster.score>=40?"Moderate":"Watch"; });
  clusters.sort((a,b)=>b.score-a.score||b.members.length-a.members.length); return `<section class="overlap-map"><div class="section-head"><div><h3>Ranked bot overlap map</h3><span class="subtle">Concentration score · shared exposure, activity, allocation, and paper deterioration</span></div><span>${clusters.length} cluster${clusters.length===1?"":"s"}</span></div>${clusters.length?`<div class="overlap-grid">${clusters.slice(0,8).map((cluster,index)=>`<article class="overlap-${cluster.level.toLowerCase()}"><div class="overlap-rank"><b>#${index+1}</b><span>${cluster.score}/100 · ${cluster.level}</span></div><span>${escapeHtml(cluster.kind)}</span><strong>${escapeHtml(cluster.name)}</strong><b>${cluster.members.length} bots · ${cluster.active} on · ${money(cluster.allocation)} planned</b><p>${escapeHtml(cluster.note)}</p><small>${[...cluster.members].sort(compareBotRank).slice(0,5).map((bot)=>`${escapeHtml(bot.name)} (${botConfidence(bot).score})`).join(" · ")}${cluster.members.length>5?` · +${cluster.members.length-5} more`:""}</small></article>`).join("")}</div>`:`<div class="card all-clear"><strong>No material overlap clusters detected</strong><span>Current bot configurations are not concentrated by the transparent grouping rules.</span></div>`}</section>`;
}

function renderUnmanagedExposure(portfolio = {}, observed = {}) {
  const attribution = observed.position_attribution || [], unmanaged = attribution.filter((item) => item.classification === "unmanaged"), mixed = attribution.filter((item) => item.classification === "mixed"), pending = (portfolio.pending_orders || []).filter((order) => order.attribution === "unmanaged");
  const positionRows = unmanaged.map((item) => { const position = (portfolio.positions || []).find((candidate) => candidate.symbol === item.symbol) || {}; return `<div class="unmanaged-row"><div><strong>${escapeHtml(item.symbol)}</strong><span>${escapeHtml(item.asset_class)} · ${Number(item.broker_quantity).toLocaleString(undefined,{maximumFractionDigits:8})} qty</span></div><div><span>Market value</span><strong>${money(position.market_value)}</strong></div><div><span>Unrealized P&amp;L</span><strong class="${Number(position.unrealized_pl)>0?"profit":Number(position.unrealized_pl)<0?"loss":""}">${money(position.unrealized_pl)}</strong></div><b class="attribution-badge ${item.confidence}">${escapeHtml(item.confidence)}</b></div>`; }).join("");
  const orderRows = pending.slice(0, 8).map((order) => `<div class="unmanaged-order"><strong>${escapeHtml(order.symbol)}</strong><span>${escapeHtml(order.side || "multi-leg")} · ${escapeHtml(order.order_type || "order")} · ${escapeHtml(order.status)}</span></div>`).join("");
  return `<section class="unmanaged-exposure"><div class="section-head"><div><h3>Unmanaged broker exposure</h3><span class="subtle">Alpaca positions and orders not associated with a BotGarden order record</span></div><span>${unmanaged.length} position${unmanaged.length===1?"":"s"} · ${pending.length} order${pending.length===1?"":"s"}</span></div><div class="card unmanaged-card">${positionRows || `<div class="empty compact"><strong>No wholly unmanaged positions detected</strong></div>`}${mixed.length ? `<div class="mixed-warning"><strong>${mixed.length} mixed position${mixed.length===1?"":"s"} require individual review.</strong> Bot-managed and unmanaged quantities share the same Alpaca symbol, so bulk closing would affect both.</div>` : ""}${orderRows ? `<div class="unmanaged-orders">${orderRows}${pending.length>8?`<small>+${pending.length-8} more</small>`:""}</div>` : ""}<div class="unmanaged-actions"><button class="danger-button" data-close-unmanaged-all ${unmanaged.length?"":"disabled"}>Close unmanaged positions</button><button class="secondary" data-cancel-unmanaged-all ${pending.length?"":"disabled"}>Cancel unmanaged orders</button></div><p>“Close” covers selling long positions and buying back short positions. Stock and option closes may fail while their markets are closed; crypto can close continuously. Estimated attribution reflects incomplete older fill history.</p></div></section>`;
}

async function loadDashboard() {
  const [{ data: botData }, connection, { data: backtests }, portfolio, observedPerformance, operational] = await Promise.all([
    supabase.from("bg_bots").select("id,name,bot_type,status,asset_class,symbol,direction,max_allocation,max_active_trades,start_condition,take_profit_pct,stop_loss_pct,cooldown_seconds,session_policy,created_at").order("created_at", { ascending: false }),
    getConnection(),
    supabase.from("bg_backtests").select("bot_id,status,duration_seconds,initial_capital,net_pnl,return_pct,max_drawdown_pct,trade_count,win_count,loss_count,signal_count,estimated_pnl,estimated_return_pct,daily_regimes,walk_forward,start_at,end_at,created_at").in("status", ["completed", "signal_only"]),
    invoke("portfolio-snapshot", {}).catch((error) => ({ connected: false, account: null, positions: [], error: error.message })),
    invoke("bot-performance", {}).catch((error) => ({ bots: [], error: error.message })),
    invoke("operations-control", { action: "status" }).catch((error) => ({ health: [], error: error.message })),
  ]);
  paperPerformance = new Map((observedPerformance?.bots || []).map((item) => [item.bot_id, item]));
  paperPerformanceMeta = observedPerformance;
  backtestSummary = new Map();
  latestBacktest = new Map();
  (backtests || []).forEach((test) => { const current = backtestSummary.get(test.bot_id) || { seconds: 0, runs: 0, signalOnlyRuns: 0, signals: 0, trades: 0, wins: 0, losses: 0, positiveRuns: 0, evaluatedRuns: 0, maxDrawdown: 0, validationReturns: [], testedDates: new Set(), pnl: 0, capital: 0, profitPct: null, estimatedPnl: 0, estimatedCapital: 0, estimatedPct: null }; current.seconds += Number(test.duration_seconds); current.runs++; (test.daily_regimes || []).forEach((day) => current.testedDates.add(day.date)); current.trades += Number(test.trade_count || 0); current.wins += Number(test.win_count || 0); current.losses += Number(test.loss_count || 0); current.maxDrawdown = Math.max(current.maxDrawdown, Number(test.max_drawdown_pct || 0)); const validation = test.status === "signal_only" ? test.walk_forward?.validation_estimated_return_pct : test.walk_forward?.validation_return_pct; if (validation != null) current.validationReturns.push(Number(validation)); const evaluated = test.status === "signal_only" ? test.estimated_return_pct : test.return_pct; if (evaluated != null) { current.evaluatedRuns++; if (Number(evaluated) > 0) current.positiveRuns++; } if (test.status === "signal_only") { current.signalOnlyRuns++; current.signals += Number(test.signal_count || 0); if (test.estimated_pnl != null) { current.estimatedPnl += Number(test.estimated_pnl); current.estimatedCapital += Number(test.initial_capital); current.estimatedPct = current.estimatedPnl / current.estimatedCapital * 100; } } if (test.net_pnl != null) { current.pnl += Number(test.net_pnl); current.capital += Number(test.initial_capital); current.profitPct = current.capital ? current.pnl / current.capital * 100 : null; } backtestSummary.set(test.bot_id, current); const latest = latestBacktest.get(test.bot_id); if (!latest || new Date(test.created_at) > new Date(latest.created_at)) latestBacktest.set(test.bot_id, test); });
  bots = botData || []; bots.sort(compareBotRank);
  updatePruneButton();
  const active = bots.filter((b) => b.status === "active").length;
  const positions = portfolio?.positions || [], account = portfolio?.account;
  const unrealizedPnl = positions.reduce((sum, position) => sum + Number(position.unrealized_pl || 0), 0);
  const dailyChange = account ? Number(account.equity) - Number(account.last_equity) : null;
  const dailyChangePct = account?.last_equity ? dailyChange / Number(account.last_equity) * 100 : null;
  const pnlClass = (value) => Number(value) > 0 ? "profit" : Number(value) < 0 ? "loss" : "";
  const assetLabels = { equity: "Stocks", option: "Options", crypto: "Crypto" };
  const assetSummary = Object.keys(assetLabels).map((assetClass) => {
    const matching = positions.filter((position) => position.asset_class === assetClass);
    const marketValue = matching.reduce((sum, position) => sum + Math.abs(Number(position.market_value || 0)), 0);
    const pnl = matching.reduce((sum, position) => sum + Number(position.unrealized_pl || 0), 0);
    return `<div class="overview-asset"><div><strong>${assetLabels[assetClass]}</strong><span>${matching.length} open position${matching.length === 1 ? "" : "s"}</span></div><div><span>Market value</span><strong>${money(marketValue)}</strong></div><div><span>Unrealized P&amp;L</span><strong class="${pnlClass(pnl)}">${money(pnl)}</strong></div></div>`;
  }).join("");
  const botCounts = Object.keys(assetLabels).map((assetClass) => {
    const matching = bots.filter((bot) => bot.asset_class === assetClass), running = matching.filter((bot) => bot.status === "active").length;
    return `<div><span>${assetLabels[assetClass]}</span><strong>${running} on</strong><small>${matching.length} configured</small></div>`;
  }).join("");
  const snapshotMessage = portfolio?.error ? "Live account data is temporarily unavailable" : account ? `Updated ${new Date(portfolio.as_of).toLocaleString()}` : "Connect Alpaca to sync";
  const unattributedFills = Number(paperPerformanceMeta?.unattributed_fill_count || 0), reconciliationAlert = unattributedFills ? `<div class="callout reconciliation-alert"><strong>Broker reconciliation needs attention</strong><br>${unattributedFills} recent Alpaca fill${unattributedFills === 1 ? " is" : "s are"} not attributed to a BotGarden bot. Review Activity before judging bot-level P&amp;L.</div>` : "";
  content.innerHTML = `
    ${reconciliationAlert}
    <div class="overview-toolbar"><div><span class="eyebrow">RESEARCH</span><h2>Paper portfolio overview</h2><p>Refresh comparable evidence across the entire garden.</p></div><button class="primary" data-backtest-all ${batchBacktestRunning ? "disabled" : ""}>${batchBacktestRunning ? "Backtesting all…" : "Backtest all · 30 days"}</button></div>
    ${renderActionCenter(operational)}
    <div class="cards">
      <div class="card metric"><span class="label">PAPER EQUITY</span><strong>${account ? money(account.equity) : "—"}</strong><div class="subtle">${snapshotMessage}</div></div>
      <div class="card metric"><span class="label">ACTIVE BOTS</span><strong>${active}</strong><div class="subtle">${bots.length} configured</div></div>
      <div class="card metric"><span class="label">OPEN POSITIONS</span><strong>${positions.length}</strong><div class="subtle">Across stocks, options, and crypto</div></div>
      <div class="card metric"><span class="label">UNREALIZED P&amp;L</span><strong class="${pnlClass(unrealizedPnl)}">${account ? money(unrealizedPnl) : "—"}</strong><div class="subtle">Current open positions</div></div>
    </div>
    <div class="section-head"><h3>Account snapshot</h3></div>
    <div class="card overview-account">
      <div><span>Today's equity change</span><strong class="${pnlClass(dailyChange)}">${dailyChange == null ? "—" : `${money(dailyChange)} (${dailyChangePct >= 0 ? "+" : ""}${pct(dailyChangePct)})`}</strong></div>
      <div><span>Cash</span><strong>${account ? money(account.cash) : "—"}</strong></div>
      <div><span>Buying power</span><strong>${account ? money(account.buying_power) : "—"}</strong></div>
      <div><span>Long market value</span><strong>${account ? money(account.long_market_value) : "—"}</strong></div>
    </div>
    <div class="section-head"><h3>30-day paper equity</h3></div>
    ${renderEquityHistory(portfolio?.history || [])}
    <div class="section-head"><h3>Portfolio risk health</h3><span class="subtle">Advisory indicators · not automatic limits</span></div>
    ${renderRiskHealth(account, positions)}
    ${renderUnmanagedExposure(portfolio, observedPerformance)}
    ${renderOverlapMap()}
    <div class="section-head"><h3>Open exposure</h3></div>
    <div class="card overview-assets">${assetSummary}</div>
    <div class="section-head"><h3>Automation summary</h3></div>
    <div class="card overview-bots">${botCounts}</div>
    ${workerHealthBlock(operational)}
    <div class="section-head"><h3>Alpaca paper account</h3></div>
    <div class="card connection-card"><div class="connection-state"><div><span class="connection-dot ${connection?.status === "connected" ? "on" : ""}"></span><strong>${connection ? "Alpaca connected · keys saved" : "Not connected"}</strong><div class="subtle">${connection ? `Paper account ${escapeHtml(connection.account_number || "")} · encrypted credentials are remembered by BotGarden${connection.last_verified_at ? ` · verified ${new Date(connection.last_verified_at).toLocaleString()}` : ""}` : "Add your own Alpaca paper API credentials once."}</div></div><button class="secondary" data-connect>${connection ? "Replace saved keys" : "Connect account"}</button></div></div>
    <div class="runner-note"><strong>Two-speed paper automation active.</strong> Entry signals remain on the five-minute schedule, while open stock, option, and crypto positions receive a dedicated risk-and-exit check every minute.</div>`;
}

async function refreshWorkspace(view = currentView) {
  await loadDashboard();
  if (view !== "dashboard") switchView(view);
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

function paperPnlBlock(bot) {
  const performance = paperPerformance.get(bot.id);
  if (!performance?.fill_count) return `<div class="paper-pnl empty-pnl" title="No Alpaca fills have been attributed to this BotGarden bot"><span>PAPER P&amp;L</span><strong>—</strong><small>No attributed fills yet</small></div>`;
  const total = Number(performance.total_pnl || 0), realized = Number(performance.realized_pnl || 0), unrealized = Number(performance.unrealized_pnl || 0), incomplete = !performance.mark_to_market_complete || paperPerformanceMeta?.truncated;
  return `<div class="paper-pnl ${total > 0 ? "profit" : total < 0 ? "loss" : ""}" title="Observed Alpaca paper fills attributed by broker order ID${incomplete ? "; some historical or mark-to-market data is incomplete" : ""}"><span>PAPER P&amp;L</span><strong>${money(total)}</strong><small>${money(realized)} realized · ${money(unrealized)} open${incomplete ? " · partial" : ""}</small></div>`;
}

function botConfidence(bot, universe = bots) {
  const summary = backtestSummary.get(bot.id) || {}, paper = paperPerformance.get(bot.id) || {}, coverageDays = Number(summary.testedDates?.size || 0), observations = bot.asset_class === "option" ? Math.min(Number(summary.signals || 0), coverageDays * 3) : Math.min(Number(summary.trades || 0), coverageDays * 5), validationValues = summary.validationReturns || [], validationAverage = validationValues.length ? validationValues.reduce((sum, value) => sum + value, 0) / validationValues.length : null, clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const evidence = clamp(coverageDays / 20 * 10, 0, 10) + clamp(observations / 30 * 15, 0, 15), validation = validationAverage == null ? 0 : clamp(12.5 + validationAverage * 2.5, 0, 25), consistency = summary.evaluatedRuns ? Number(summary.positiveRuns || 0) / Number(summary.evaluatedRuns) * 15 : 0, risk = summary.evaluatedRuns ? clamp(15 - Number(summary.maxDrawdown || 0) * 1.25, 0, 15) : 0, fillCount = Number(paper.fill_count || 0), paperReturn = Number(bot.max_allocation) ? Number(paper.total_pnl || 0) / Number(bot.max_allocation) * 100 : 0, paperScore = fillCount ? clamp(fillCount / 20 * 8, 0, 8) + clamp(6 + paperReturn * 2, 0, 12) : 0;
  const family = bot.start_condition?.generated_strategy, siblingCount = family ? universe.filter((item) => item.start_condition?.generated_strategy === family).length : 1, selectionPenalty = coverageDays < 20 && siblingCount > 5 ? clamp(Math.log2(siblingCount) * 1.5, 0, 8) : 0; let score = Math.round(clamp(evidence + validation + consistency + risk + paperScore - selectionPenalty, 0, 100)); if (fillCount < 10) score = Math.min(score, 74); if (bot.asset_class === "option" && fillCount < 10) score = Math.min(score, 55);
  const label = score >= 75 ? "High confidence" : score >= 60 ? "Promising" : score >= 40 ? "Experimental" : score >= 20 ? "Low evidence" : "Unproven";
  return { score, label, validationAverage, coverageDays, observations, fillCount, siblingCount, breakdown: { Evidence: evidence, "Unseen validation": validation, Consistency: consistency, "Drawdown control": risk, "Observed paper": paperScore, "Selection penalty": -selectionPenalty } };
}

function botMaturity(bot) {
  const confidence = botConfidence(bot), paper = paperPerformance.get(bot.id) || {}, paperPnl = Number(paper.total_pnl || 0), validated = confidence.coverageDays >= 10 && confidence.observations >= 10 && confidence.validationAverage > 0 && confidence.score >= 40;
  if ((confidence.fillCount >= 10 && paperPnl < 0) || (confidence.coverageDays >= 20 && confidence.validationAverage < -2)) return { id: "degraded", label: "Degraded", note: "Meaningful paper or unseen evidence has deteriorated; review before allocating more capital." };
  if (validated && confidence.score >= 75 && confidence.fillCount >= 10 && paperPnl > 0 && confidence.coverageDays >= 20 && confidence.observations >= 20) return { id: "proven", label: "Proven paper", note: "Passed historical, unseen, and minimum observed-paper evidence gates." };
  if (validated && confidence.score >= 60) return { id: "candidate", label: "Paper candidate", note: "Historically credible enough to collect controlled paper evidence." };
  if (validated) return { id: "validated", label: "Historically validated", note: "Positive unseen result with minimum unique-day and trade/signal coverage." };
  return { id: "experimental", label: "Experimental", note: "Still gathering sufficient independent historical evidence." };
}

function compareBotRank(a, b) {
  const confidenceA = botConfidence(a), confidenceB = botConfidence(b);
  if (confidenceA.score !== confidenceB.score) return confidenceB.score - confidenceA.score;
  const summaryA = backtestSummary.get(a.id) || {}, summaryB = backtestSummary.get(b.id) || {};
  const resultA = a.asset_class === "option" ? summaryA.estimatedPct : summaryA.profitPct;
  const resultB = b.asset_class === "option" ? summaryB.estimatedPct : summaryB.profitPct;
  if (Number.isFinite(Number(resultA)) || Number.isFinite(Number(resultB))) {
    const difference = (Number.isFinite(Number(resultB)) ? Number(resultB) : -Infinity) - (Number.isFinite(Number(resultA)) ? Number(resultA) : -Infinity);
    if (difference) return difference;
  }
  const paperA = Number(paperPerformance.get(a.id)?.total_pnl || 0), paperB = Number(paperPerformance.get(b.id)?.total_pnl || 0);
  if (paperA !== paperB) return paperB - paperA;
  if (confidenceA.coverageDays !== confidenceB.coverageDays) return confidenceB.coverageDays - confidenceA.coverageDays;
  return new Date(b.created_at) - new Date(a.created_at);
}

function confidenceBadge(bot, rank) { const confidence = botConfidence(bot), maturity = botMaturity(bot); return `<div class="bot-ranking"><div class="confidence-badge score-${Math.floor(confidence.score / 20)}" title="Evidence-weighted score; not a forecast or profit guarantee"><b>#${rank}</b><span>${confidence.score}/100</span><small>${confidence.label}</small></div><span class="maturity-badge ${maturity.id}" title="${escapeHtml(maturity.note)}">${escapeHtml(maturity.label)}</span></div>`; }

function promotionLadder(assetClass) {
  const matching = bots.filter((bot) => bot.asset_class === assetClass), counts = matching.reduce((result, bot) => { const stage = botMaturity(bot).id; result[stage] = (result[stage] || 0) + 1; return result; }, {});
  return `<div class="promotion-ladder"><div><span>Experimental</span><strong>${counts.experimental || 0}</strong></div><i>→</i><div><span>Historically validated</span><strong>${counts.validated || 0}</strong></div><i>→</i><div><span>Paper candidate</span><strong>${counts.candidate || 0}</strong></div><i>→</i><div><span>Proven paper</span><strong>${counts.proven || 0}</strong></div>${counts.degraded ? `<div class="degraded"><span>Degraded</span><strong>${counts.degraded}</strong></div>` : ""}</div>`;
}

function renderBots() {
  if (!bots.length) return `<div class="empty"><h3>No bots yet</h3><div>Create a DCA bot and preview its complete averaging schedule.</div><button class="primary" data-new-bot>Create your first bot</button></div>`;
  const row = (bot, isOption, rank) => {
    const summary = backtestSummary.get(bot.id) || { seconds: 0, runs: 0, signalOnlyRuns: 0, signals: 0, profitPct: null, estimatedPct: null }, isOn = bot.status === "active";
    const performance = isOption ? (summary.estimatedPct == null ? (summary.signalOnlyRuns ? "No estimate" : "Not tested") : `~${pct(summary.estimatedPct)}`) : (summary.profitPct == null ? "Not tested" : pct(summary.profitPct));
    const coverage = isOption ? `${summary.signals} triggers · ${formatDuration(summary.seconds)}${summary.estimatedPct == null ? "" : " · low confidence"}` : `${formatDuration(summary.seconds)} · ${summary.runs} run${summary.runs === 1 ? "" : "s"}`;
    const performanceClass = isOption ? (summary.estimatedPct > 0 ? "profit" : summary.estimatedPct < 0 ? "loss" : "") : (summary.profitPct > 0 ? "profit" : summary.profitPct < 0 ? "loss" : "");
    return `<div class="bot-row"><div><div class="bot-title-line"><div><div class="bot-name">${escapeHtml(bot.name)}</div><div class="subtle">${escapeHtml(bot.symbol)} · ${escapeHtml(bot.bot_type.replaceAll("_", " "))}</div></div>${confidenceBadge(bot, rank)}</div>${paperPnlBlock(bot)}</div><button class="bot-toggle ${isOn ? "on" : ""}" data-toggle-bot="${bot.id}" role="switch" aria-checked="${isOn}"><span></span>${isOn ? "ON" : "OFF"}</button><div><div class="subtle">${isOption ? "ESTIMATED REPLAY" : "BACKTEST PROFIT"}</div><strong class="${performanceClass}">${performance}</strong><div class="subtle">${coverage}</div></div>${stockSparkline(bot)}<div><div class="subtle">MAX ${isOption ? "RISK" : "ALLOCATION"}</div>${money(bot.max_allocation)}</div><div class="row-actions"><button class="icon-action" data-bot-details="${bot.id}" title="View bot details" aria-label="View details for ${escapeHtml(bot.name)}">${actionIcon("details")}</button><button class="icon-action test" data-backtest="${bot.id}" title="${isOption ? "Replay" : "Backtest"} this bot" aria-label="${isOption ? "Replay" : "Backtest"} ${escapeHtml(bot.name)}">${actionIcon("test")}</button><button class="icon-action child" data-child-bot="${bot.id}" title="Add a randomized child and test it over the same number of days" aria-label="Add random child of ${escapeHtml(bot.name)}">${actionIcon("child")}</button><button class="delete-button" data-delete-bot="${bot.id}" title="Remove bot" aria-label="Delete ${escapeHtml(bot.name)}">×</button></div></div>`;
  };
  const stocks = bots.filter((bot) => bot.asset_class === "equity").sort(compareBotRank), options = bots.filter((bot) => bot.asset_class === "option").sort(compareBotRank);
  if (securitiesFilter === "option") return options.length ? `<div class="bot-groups"><section><div class="group-heading"><div><h3>Option strategies</h3><p>Ranked by evidence-weighted Bot Confidence Score</p></div><span>${options.length}</span></div><div class="option-explainer">Option scores are capped until real Alpaca paper fills provide evidence. Estimated replay remains a low-confidence pruning aid—not actual historical option P&amp;L.</div><div class="bot-list">${options.map((bot, index) => row(bot, true, index + 1)).join("")}</div></section></div>` : `<div class="empty"><h3>No option bots yet</h3><div>Create or randomize an option strategy to begin.</div></div>`;
  return stocks.length ? `<div class="bot-groups"><section><div class="group-heading"><div><h3>Stock bots</h3><p>Ranked by evidence-weighted Bot Confidence Score</p></div><span>${stocks.length}</span></div><div class="bot-list">${stocks.map((bot, index) => row(bot, false, index + 1)).join("")}</div></section></div>` : `<div class="empty"><h3>No stock bots yet</h3><div>Create or randomize a stock strategy to begin.</div></div>`;
}

function renderSecuritiesWorkspace() {
  const stockCount = bots.filter((bot) => bot.asset_class === "equity").length, optionCount = bots.filter((bot) => bot.asset_class === "option").length;
  content.innerHTML = `<div class="securities-switch" role="tablist" aria-label="Stock or option bots"><button class="${securitiesFilter === "equity" ? "active" : ""}" data-securities-filter="equity" role="tab" aria-selected="${securitiesFilter === "equity"}">Stocks <span>${stockCount}</span></button><button class="${securitiesFilter === "option" ? "active" : ""}" data-securities-filter="option" role="tab" aria-selected="${securitiesFilter === "option"}">Options <span>${optionCount}</span></button></div>${promotionLadder(securitiesFilter)}${renderBots()}`;
}

async function toggleBot(botId) {
  const bot = bots.find((item) => item.id === botId); if (!bot) return;
  const next = bot.status === "active" ? "paused" : "active";
  const { error } = await supabase.from("bg_bots").update({ status: next, updated_at: new Date().toISOString() }).eq("id", botId);
  if (!error) await refreshWorkspace();
}

function renderCrypto() {
  const cryptoBots = bots.filter((bot) => bot.asset_class === "crypto").sort(compareBotRank);
  const rows = cryptoBots.map((bot,index) => {
    const summary = backtestSummary.get(bot.id), isOn = bot.status === "active", result = summary?.profitPct == null ? "Not tested" : pct(summary.profitPct);
    const family=bot.start_condition?.generated_strategy||"atr_adaptive_grid",label={crypto_dca:"DCA + safety orders",crypto_regime_allocator:"Regime-gated allocator",crypto_vol_momentum:"Volatility-targeted momentum",crypto_shock_recovery:"Shock + recovery",atr_adaptive_grid:"ATR-adaptive grid",crypto_smart_trailing:"Smart trailing reversal",crypto_scheduled_accumulation:"Volatility-aware accumulation"}[family]||family.replaceAll("_"," ");
    return `<div class="bot-row"><div><div class="bot-title-line"><div><div class="bot-name">${escapeHtml(bot.name)}</div><div class="subtle">${escapeHtml(bot.symbol)} · ${escapeHtml(label)} · 24/7</div></div>${confidenceBadge(bot,index+1)}</div>${paperPnlBlock(bot)}</div><button class="bot-toggle ${isOn ? "on" : ""}" data-toggle-bot="${bot.id}" role="switch" aria-checked="${isOn}"><span></span>${isOn ? "ON" : "OFF"}</button><div><div class="subtle">HISTORICAL REPLAY</div><strong class="${summary?.profitPct > 0 ? "profit" : summary?.profitPct < 0 ? "loss" : ""}">${result}</strong><div class="subtle">${formatDuration(summary?.seconds || 0)}</div></div>${stockSparkline(bot)}<div><div class="subtle">MAX ALLOCATION</div>${money(bot.max_allocation)}</div><div class="row-actions"><button class="icon-action" data-bot-details="${bot.id}" title="View strategy details">${actionIcon("details")}</button><button class="icon-action test" data-backtest="${bot.id}" title="Replay this strategy">${actionIcon("test")}</button><button class="icon-action child" data-crypto-child="${bot.id}" title="Create a randomized child with matched replay coverage">${actionIcon("child")}</button><button class="delete-button" data-delete-bot="${bot.id}" title="Remove bot">×</button></div></div>`;
  }).join("");
  const pruneCount=botsBelowThreshold(2,"crypto").length;
  content.innerHTML = `<div class="crypto-hero"><div><span class="crypto-badge">ALPACA CRYPTO · 24/7</span><h2>Crypto has its own workspace</h2><p>Adaptive grids, volatility-aware accumulation, and pullback/rebound trailing bots run independently of stock-market hours.</p><div class="crypto-note">Paper results are simulations, not profit guarantees. Crypto is volatile and availability depends on your jurisdiction and Alpaca account.</div></div><div><button class="crypto-action" data-new-crypto>+ Crypto bot</button> <button class="secondary" data-new-crypto-batch>Random crypto batch</button></div></div>${promotionLadder("crypto")}<div class="section-head"><div><h3>Crypto bots</h3><span class="subtle">Ranked by evidence-weighted Bot Confidence Score</span></div><button class="prune-button" data-prune-crypto ${pruneCount?"":"disabled"}>Smart prune (${pruneCount})</button></div>${rows ? `<div class="bot-list">${rows}</div>` : `<div class="empty"><h3>No crypto bots yet</h3><div>Create a risk-bounded strategy around a liquid USD crypto pair.</div><button class="primary" data-new-crypto>Create crypto bot</button></div>`}<div class="section-head"><h3>Crypto strategy families</h3></div><div class="strategy-roadmap"><div class="strategy-card live"><strong>Adaptive grid · Live</strong><span>Trades repeated range movement with ATR-sized boundaries.</span></div><div class="strategy-card live"><strong>Smart trailing · Live</strong><span>Waits for a volatility-scaled pullback and confirmed rebound.</span></div><div class="strategy-card live"><strong>Scheduled accumulation · Live</strong><span>Deploys bounded installments with volatility-aware spacing.</span></div><div class="strategy-card"><strong>Portfolio rebalancer · Next</strong><span>Requires coordinated basket fills and portfolio drift state.</span></div><div class="strategy-card"><strong>Pairs mean reversion · Next</strong><span>Requires synchronized two-leg orders and hedge-ratio accounting.</span></div><div class="strategy-card"><strong>Webhook signals · Next</strong><span>Requires signed inbound alerts and replay-safe event IDs.</span></div></div>`;
  const pruneButton = content.querySelector("[data-prune-crypto]"); if (pruneButton) { pruneButton.textContent = `Smart prune & clean up (${pruneCount})`; pruneButton.title = "Removes weak crypto bots, cancels unmanaged orders, and closes wholly unmanaged positions"; }
}

async function createCryptoStrategy(strategy,risk,days,asset){
  const atr=Math.max(.5,Number(asset.atr_pct)),base=asset.symbol.replace("/USD","");let config,conditions,botType="signal",name,takeProfit=null,stopLoss=null,cooldown=300;
  if(strategy==="crypto_dca"){const variant=pick(["oversold_entry","trend_pullback","recovery_confirmed"]),safetyCount=pick([3,4,5]),initial=Math.max(10,Math.floor(risk*pick([.18,.2,.22,.25]))),remaining=risk-initial,scale=pick([1.15,1.25,1.35]),weights=Array.from({length:safetyCount},(_,i)=>Math.pow(scale,i)),weightTotal=weights.reduce((a,b)=>a+b,0),deviationStep=Math.max(1.2,Math.min(5,atr*pick([.65,.8,1]))),steps=[{step:0,deviation:0,amount:initial},...weights.map((weight,i)=>({step:i+1,deviation:Number((deviationStep*Math.pow(i+1,1.18)).toFixed(2)),amount:Number((remaining*weight/weightTotal).toFixed(2))}))];config={variant,safety_orders:safetyCount,deviation_step_pct:Number(deviationStep.toFixed(2)),volume_scale:scale,steps};conditions=variant==="trend_pullback"?[{type:"moving_average",timeframe:"15Min",parameters:{average:"ema",fast:20,slow:50,operator:"above"}},{type:"rsi",timeframe:"15Min",parameters:{period:14,operator:"below",value:pick([44,46,48])}}]:variant==="recovery_confirmed"?[{type:"rsi",timeframe:"5Min",parameters:{period:14,operator:"above",value:pick([32,34,36])}},{type:"percent_change",timeframe:"5Min",parameters:{anchor:"rolling",operator:"above",value:pick([.2,.35,.5])}},{type:"relative_volume",timeframe:"5Min",parameters:{lookback:20,operator:"above",value:pick([1.15,1.3,1.5])}}]:[{type:"rsi",timeframe:"5Min",parameters:{period:14,operator:"below",value:pick([36,38,40,42])}}];botType="dca";name=`${base} Smart DCA`;takeProfit=Number(Math.max(2,Math.min(8,atr*pick([1,1.25,1.5]))).toFixed(2));stopLoss=Number(Math.max(8,Math.min(20,atr*pick([3,3.5,4]))).toFixed(2));cooldown=1800;}
  else if(strategy==="atr_adaptive_grid"){const levels=pick([6,7,8,9,10,12]),halfWidth=Math.max(.04,Math.min(.18,atr/100*pick([2.5,3,3.5])));config={levels,half_width:halfWidth,order_amount:Math.max(10,Math.floor(risk/Math.ceil(levels/2)))};conditions=[{type:"immediate",timeframe:"15Min",parameters:{}}];botType="grid";name=`${base} Adaptive Grid`;}
  else if(strategy==="crypto_regime_allocator"){const variant=pick(["balanced_trend","conservative_regime","responsive_risk_on"]),targetVol=pick([2,2.5,3,3.5]),volatilityScale=Number(Math.max(.3,Math.min(1,targetVol/atr)).toFixed(2)),pair=variant==="conservative_regime"?[50,100]:variant==="responsive_risk_on"?[12,36]:[20,50],timeframe=variant==="responsive_risk_on"?"30Min":"1Hour";config={variant,target_vol_pct:targetVol,volatility_scale:volatilityScale,risk_off_atr_pct:Math.max(3.5,Math.min(9,atr*(variant==="conservative_regime"?1.15:1.4))),min_edge_bps:pick([50,65,80]),fast_ema:pair[0],slow_ema:pair[1]};conditions=[{type:"moving_average",timeframe,parameters:{average:"ema",fast:pair[0],slow:pair[1],operator:"above"}},{type:"atr",timeframe,parameters:{period:14,operator:"below",value:config.risk_off_atr_pct}}];if(variant==="responsive_risk_on")conditions.splice(1,0,{type:"rsi",timeframe,parameters:{period:14,operator:"above",value:pick([51,53,55])}});name=`${base} Regime Allocator`;takeProfit=Number(Math.max(4,Math.min(12,atr*pick([1.5,2,2.5]))).toFixed(2));stopLoss=Number(Math.max(3,Math.min(9,atr*pick([1,1.25,1.5]))).toFixed(2));}
  else if(strategy==="crypto_vol_momentum"){const variant=pick(["slow_trend","breakout_volume","fast_continuation"]),timeframe=variant==="slow_trend"?"1Hour":pick(["15Min","30Min","1Hour"]),pairs=variant==="slow_trend"?[20,55]:variant==="breakout_volume"?[12,36]:[8,24],targetVol=pick([2,2.5,3]),volatilityScale=Number(Math.max(.35,Math.min(1,targetVol/atr)).toFixed(2));config={variant,target_vol_pct:targetVol,volatility_scale:volatilityScale,min_edge_bps:pick([60,75,90]),fast_ema:pairs[0],slow_ema:pairs[1]};conditions=[{type:"moving_average",timeframe,parameters:{average:"ema",fast:pairs[0],slow:pairs[1],operator:"above"}},{type:"rsi",timeframe,parameters:{period:14,operator:"above",value:variant==="fast_continuation"?pick([54,56,58]):pick([50,52,54])}},{type:"atr",timeframe,parameters:{period:14,operator:"below",value:Math.max(4,Math.min(10,atr*1.5))}}];if(variant==="breakout_volume")conditions.splice(2,0,{type:"relative_volume",timeframe,parameters:{lookback:20,operator:"above",value:pick([1.15,1.25,1.4])}});name=`${base} Volatility Momentum`;takeProfit=Number(Math.max(3,Math.min(12,atr*pick([1.4,1.7,2]))).toFixed(2));stopLoss=Number(Math.max(2,Math.min(8,atr*pick([.75,.9,1.05]))).toFixed(2));}
  else if(strategy==="crypto_shock_recovery"){config={shock_atr_multiple:pick([1.5,2,2.5]),min_edge_bps:pick([75,90,110])};conditions=[{type:"rsi",timeframe:"15Min",parameters:{period:14,operator:"above",value:pick([34,36,38])}},{type:"percent_change",timeframe:"15Min",parameters:{anchor:"rolling",operator:"above",value:pick([.25,.4,.6])}},{type:"relative_volume",timeframe:"15Min",parameters:{lookback:20,operator:"above",value:pick([1.2,1.4,1.6])}}];name=`${base} Shock Recovery`;takeProfit=pick([4,5,6,8]);stopLoss=pick([3,4,5]);}
  else if(strategy==="crypto_smart_trailing"){config={pullback_pct:Number(Math.max(1.5,Math.min(12,atr*pick([1.5,2,2.5]))).toFixed(2)),rebound_pct:Number(Math.max(.5,Math.min(5,atr*pick([.6,.8,1]))).toFixed(2)),lookback_bars:pick([18,24,30,36])};conditions=[{type:"trailing_reversal",timeframe:"5Min",parameters:config}];name=`${base} Smart Trailing`;takeProfit=pick([4,5,6,8,10]);stopLoss=pick([3,4,5,6]);}
  else{const variant=pick(["steady_vol_target","dip_weighted","trend_confirmed"]),targetVol=pick([2,2.5,3,3.5]),volatilityScale=Number(Math.max(.35,Math.min(1,targetVol/atr)).toFixed(2)),intervalHours=atr>6?pick([18,24,36,48]):atr>3?pick([12,18,24]):pick([6,8,12,18]);config={variant,interval_hours:intervalHours,installments:pick([5,6,8,10,12]),target_vol_pct:targetVol,volatility_scale:volatilityScale,accelerated_dip_size:variant==="dip_weighted"?pick([1.15,1.25,1.4]):1};conditions=variant==="dip_weighted"?[{type:"rsi",timeframe:"1Hour",parameters:{period:14,operator:"below",value:pick([38,42,45,48])}}]:variant==="trend_confirmed"?[{type:"moving_average",timeframe:"1Hour",parameters:{average:"ema",fast:20,slow:50,operator:"above"}},{type:"atr",timeframe:"1Hour",parameters:{period:14,operator:"below",value:Math.max(4,Math.min(10,atr*1.5))}}]:[{type:"immediate",timeframe:"1Hour",parameters:{}}];name=`${base} Volatility Accumulator`;takeProfit=Number(Math.max(5,Math.min(20,atr*pick([2,2.5,3]))).toFixed(2));stopLoss=Number(Math.max(8,Math.min(25,atr*pick([3,3.5,4]))).toFixed(2));cooldown=config.interval_hours*3600;}
  if(strategy!=="atr_adaptive_grid"&&conditions.length<3&&Math.random()<.45){const timeframe=conditions[0]?.timeframe||"15Min",expansion=["crypto_vol_momentum","crypto_shock_recovery"].includes(strategy),filter=expansion?{type:"bollinger_bandwidth",timeframe,parameters:{period:pick([18,20,22]),lookback:pick([40,60,100]),operator:"above",value:pick([55,60,70])}}:{type:"atr_percentile",timeframe,parameters:{period:pick([10,14,20]),lookback:pick([40,60,100]),operator:"below",value:pick([70,75,80])}};conditions.push(filter);config.regime_filter=filter.type==="bollinger_bandwidth"?"volatility expansion":"extreme-volatility avoidance";}
  config.exit_policy={trailing_activation_pct:Number(Math.max(1.5,Math.min(6,atr*pick([.7,.9,1.1]))).toFixed(2)),trailing_distance_pct:Number(Math.max(.8,Math.min(4,atr*pick([.4,.55,.7]))).toFixed(2)),break_even_trigger_pct:Number(Math.max(1,Math.min(4,atr*.65)).toFixed(2)),break_even_floor_pct:.15,max_hold_hours:strategy==="crypto_scheduled_accumulation"?pick([168,240,336]):pick([24,48,72,120]),max_crypto_exposure_pct:pick([35,40,50]),max_daily_drawdown_pct:pick([2,2.5,3]),max_spread_pct:strategy==="crypto_dca"?pick([.4,.5,.6]):pick([.25,.35,.5])};
  const{data:bot,error}=await supabase.from("bg_bots").insert({user_id:session.user.id,name,bot_type:botType,status:"active",broker:"alpaca",environment:"paper",asset_class:"crypto",symbol:asset.symbol,direction:"long",max_allocation:risk,max_active_trades:strategy==="atr_adaptive_grid"?config.levels:1,start_condition:{operator:"AND",conditions,generated_strategy:strategy,strategy_config:config,randomized_fields:{Strategy:strategy.replaceAll("_"," "),Pair:asset.symbol,"ATR %":atr.toFixed(2),...config}},take_profit_pct:takeProfit,stop_loss_pct:stopLoss,cooldown_seconds:cooldown,session_policy:"continuous"}).select().single();if(error)throw error;
  if(strategy==="atr_adaptive_grid"){const lower=asset.price*(1-config.half_width),upper=asset.price*(1+config.half_width),{error:gridError}=await supabase.from("bg_grid_configs").insert({bot_id:bot.id,user_id:session.user.id,lower_price:lower,upper_price:upper,grid_levels:config.levels,order_amount:config.order_amount,spacing_mode:"geometric",recenter_enabled:true,fee_bps:25});if(gridError){await supabase.from("bg_bots").delete().eq("id",bot.id);throw gridError;}}
  if(strategy==="crypto_dca"){const{error:stepsError}=await supabase.from("bg_averaging_steps").insert(config.steps.map(step=>({bot_id:bot.id,step_number:step.step,deviation_pct:step.deviation,order_amount:step.amount})));if(stepsError){await supabase.from("bg_bots").delete().eq("id",bot.id);throw stepsError;}}
  try{await autoBacktest(bot.id,days)}catch(error){console.warn("Crypto replay failed",error)}return bot;
}

async function createCryptoChild(botId,button){
  const parent=bots.find(bot=>bot.id===botId);if(!parent)return;const latest=latestBacktest.get(botId),days=Math.max(1,Math.min(60,Number(latest?.daily_regimes?.length)||Math.round(Number(latest?.duration_seconds||432000)/86400)||5)),strategy=parent.start_condition?.generated_strategy||"crypto_dca";button.disabled=true;button.classList.add("working");const title=button.title;button.title=`Creating and replaying ${days}-day crypto child…`;
  try{const market=await invoke("crypto-market",{}),asset=market.assets.find(item=>item.symbol===parent.symbol);if(!asset)throw new Error("Current crypto metrics are unavailable for this pair");const child=await createCryptoStrategy(strategy,Number(parent.max_allocation),days,asset),childRule={...(child.start_condition||{}),parent_bot_id:parent.id,generation_kind:"child",randomized_fields:{...(child.start_condition?.randomized_fields||{}),Parent:parent.name,"Matched replay days":days}};await supabase.from("bg_bots").update({name:`${parent.name} Child`,start_condition:childRule}).eq("id",child.id);await refreshWorkspace("crypto");}
  catch(error){console.error("Crypto child creation failed",error);button.disabled=false;button.classList.remove("working");button.title=`Child failed: ${error.message||"try again"}`;setTimeout(()=>button.title=title,5000);}
}

async function showCryptoGridForm() {
  modal.showModal();
  $("#modal-content").innerHTML = `<form id="crypto-grid-form"><div class="modal-head"><div><h3>Create a smart crypto bot</h3><p>Parameters are bounded and scaled to recent volatility.</p></div><button type="button" class="icon-button" data-close-modal>×</button></div><div class="modal-body"><div class="callout">Major USD pairs only. Maximum allocation is a hard paper-trading budget. Historical profit does not guarantee future results.</div><div class="form-grid"><label>Strategy<select name="strategy"><option value="atr_adaptive_grid">ATR-adaptive grid</option><option value="crypto_smart_trailing">Smart trailing reversal</option><option value="crypto_scheduled_accumulation">Volatility-aware accumulation</option></select></label><label>Maximum allocation<input name="risk" type="number" min="50" step="25" value="500" required></label><label>Replay days<input name="days" type="number" min="1" max="60" value="5" required></label></div><p class="form-message" id="crypto-message"></p></div><div class="modal-foot"><button type="button" class="secondary" data-close-modal>Cancel</button><button class="crypto-action" type="submit">Create and replay</button></div></form>`;
  $("#crypto-grid-form").elements.strategy.insertAdjacentHTML("afterbegin",`<option value="crypto_dca">DCA + safety orders (3Commas style)</option>`);
  $("#crypto-grid-form").addEventListener("submit", async (event) => {
    event.preventDefault(); const button = event.submitter, data = new FormData(event.currentTarget); button.disabled = true; button.textContent = "Sizing grid…";
    try {
      const market = await invoke("crypto-market", {}), candidates = market.assets.filter((asset) => asset.price > 0 && asset.atr_pct > 0); if (!candidates.length) throw new Error("No supported crypto market data is available");
      const asset = pick(candidates);button.textContent = "Replaying…";await createCryptoStrategy(String(data.get("strategy")),Number(data.get("risk")),Number(data.get("days")),asset);modal.close();await refreshWorkspace("crypto");
    } catch (error) { $("#crypto-message").textContent = error.message || "Unable to create crypto grid"; button.disabled = false; button.textContent = "Create and replay"; }
  });
}

async function showCryptoBatchForm(){
  modal.showModal();$("#modal-content").innerHTML=`<form id="crypto-batch-form"><div class="modal-head"><div><h3>Random crypto batch</h3><p>Create a diversified mix of volatility-aware strategies.</p></div><button type="button" class="icon-button" data-close-modal>×</button></div><div class="modal-body"><div class="form-grid"><label>Adaptive grids<input name="grids" type="number" min="0" max="50" value="4"></label><label>Smart trailing<input name="trailing" type="number" min="0" max="50" value="3"></label><label>Scheduled accumulation<input name="scheduled" type="number" min="0" max="50" value="3"></label><label>Risk per bot<input name="risk" type="number" min="50" step="25" value="500"></label><label>Replay days per bot<input name="days" type="number" min="1" max="60" value="5"></label></div><div class="bulk-progress" id="crypto-batch-progress"><span></span><strong>Ready to create 10 bots</strong></div><p class="form-message" id="crypto-batch-message"></p></div><div class="modal-foot"><button type="button" class="secondary" data-close-modal>Cancel</button><button class="crypto-action" type="submit">Create and replay batch</button></div></form>`;
  $("#crypto-batch-form").addEventListener("submit",async event=>{event.preventDefault();const button=event.submitter,data=new FormData(event.currentTarget),counts={atr_adaptive_grid:Number(data.get("grids")),crypto_smart_trailing:Number(data.get("trailing")),crypto_scheduled_accumulation:Number(data.get("scheduled"))},jobs=Object.entries(counts).flatMap(([strategy,count])=>Array.from({length:count},()=>strategy)),risk=Number(data.get("risk")),days=Number(data.get("days"));if(!jobs.length)return $("#crypto-batch-message").textContent="Choose at least one bot";button.disabled=true;try{const market=await invoke("crypto-market",{}),assets=market.assets.filter(asset=>asset.price>0&&asset.atr_pct>0);if(!assets.length)throw new Error("No supported crypto market data is available");for(let i=0;i<jobs.length;i++){const progress=$("#crypto-batch-progress");progress.querySelector("span").style.width=`${i/jobs.length*100}%`;progress.querySelector("strong").textContent=`Creating and replaying ${i+1} of ${jobs.length}…`;await createCryptoStrategy(jobs[i],risk,days,pick(assets));}$("#crypto-batch-progress span").style.width="100%";modal.close();await refreshWorkspace("crypto");}catch(error){$("#crypto-batch-message").textContent=error.message||"Batch creation failed";button.disabled=false;}});
}

async function showCryptoBatchFormV2(){
  modal.showModal();$("#modal-content").innerHTML=`<form id="crypto-batch-v2"><div class="modal-head"><div><h3>Random crypto batch</h3><p>A diversified batch led by 3Commas-style DCA bots.</p></div><button type="button" class="icon-button" data-close-modal>×</button></div><div class="modal-body"><div class="form-grid"><label>DCA + safety orders<input name="dca" type="number" min="0" max="50" value="5"></label><label>Adaptive grids<input name="grids" type="number" min="0" max="50" value="2"></label><label>Smart trailing<input name="trailing" type="number" min="0" max="50" value="2"></label><label>Scheduled accumulation<input name="scheduled" type="number" min="0" max="50" value="1"></label><label>Risk per bot<input name="risk" type="number" min="50" step="25" value="500"></label><label>Replay days per bot<input name="days" type="number" min="1" max="60" value="5"></label></div><div class="callout">DCA bots use an RSI entry, a base order, 3–5 progressively sized safety orders, expanding price deviations, and a take-profit target from the blended cost.</div><div class="bulk-progress" id="crypto-batch-v2-progress"><span></span><strong>Ready to create 10 bots</strong></div><p class="form-message" id="crypto-batch-v2-message"></p></div><div class="modal-foot"><button type="button" class="secondary" data-close-modal>Cancel</button><button class="crypto-action" type="submit">Create and replay batch</button></div></form>`;
  $("#crypto-batch-v2").addEventListener("submit",async event=>{event.preventDefault();const button=event.submitter,data=new FormData(event.currentTarget),counts={crypto_dca:Number(data.get("dca")),atr_adaptive_grid:Number(data.get("grids")),crypto_smart_trailing:Number(data.get("trailing")),crypto_scheduled_accumulation:Number(data.get("scheduled"))},jobs=Object.entries(counts).flatMap(([strategy,count])=>Array.from({length:count},()=>strategy)),risk=Number(data.get("risk")),days=Number(data.get("days"));if(!jobs.length)return $("#crypto-batch-v2-message").textContent="Choose at least one bot";button.disabled=true;try{const market=await invoke("crypto-market",{}),assets=market.assets.filter(asset=>asset.price>0&&asset.atr_pct>0);if(!assets.length)throw new Error("No supported crypto market data is available");for(let i=0;i<jobs.length;i++){const progress=$("#crypto-batch-v2-progress");progress.querySelector("span").style.width=`${i/jobs.length*100}%`;progress.querySelector("strong").textContent=`Creating and replaying ${i+1} of ${jobs.length}…`;await createCryptoStrategy(jobs[i],risk,days,pick(assets));}modal.close();await refreshWorkspace("crypto");}catch(error){$("#crypto-batch-v2-message").textContent=error.message||"Batch creation failed";button.disabled=false;}});
}

async function showCryptoBatchFormV3(){
  const families=[{id:"crypto_dca",label:"DCA + safety orders",weight:23},{id:"crypto_regime_allocator",label:"Regime-gated allocator",weight:20},{id:"crypto_vol_momentum",label:"Volatility momentum",weight:25},{id:"crypto_shock_recovery",label:"Shock recovery",weight:8},{id:"atr_adaptive_grid",label:"Adaptive grid",weight:5},{id:"crypto_smart_trailing",label:"Smart trailing",weight:3},{id:"crypto_scheduled_accumulation",label:"Volatility accumulator",weight:16}];
  modal.showModal();$("#modal-content").innerHTML=`<form id="crypto-batch-v3"><div class="modal-head"><div><h3>Evidence-weighted crypto batch</h3><p>Creates 25 diverse bots by default and automatically replays each one.</p></div><button type="button" class="icon-button" data-close-modal>×</button></div><div class="modal-body"><div class="callout">Weights express robustness and testability—not a promise of profit. Every candidate still has to survive historical replay and your crypto-only pruning rule.</div><div class="form-grid"><label>Number of bots<input name="count" type="number" min="1" max="100" value="25"></label><label>Risk per bot<input name="risk" type="number" min="50" step="25" value="500"></label><label>Replay days per bot<input name="days" type="number" min="1" max="60" value="5"></label></div><div class="detail-grid">${families.map(family=>`<div><span>${family.label}</span><strong>${family.weight}% weight</strong></div>`).join("")}</div><div class="bulk-progress" id="crypto-batch-v3-progress"><span></span><strong>Ready to create 25 bots</strong></div><p class="form-message" id="crypto-batch-v3-message"></p></div><div class="modal-foot"><button type="button" class="secondary" data-close-modal>Cancel</button><button class="crypto-action" type="submit">Create and replay batch</button></div></form>`;
  $("#crypto-batch-v3").addEventListener("submit",async event=>{event.preventDefault();const button=event.submitter,data=new FormData(event.currentTarget),count=Number(data.get("count")),risk=Number(data.get("risk")),days=Number(data.get("days")),jobs=Array.from({length:count},()=>weightedPick(families,"weight").id);button.disabled=true;try{const market=await invoke("crypto-market",{}),assets=market.assets.filter(asset=>asset.price>0&&asset.atr_pct>0);if(!assets.length)throw new Error("No supported crypto market data is available");for(let i=0;i<jobs.length;i++){const progress=$("#crypto-batch-v3-progress");progress.querySelector("span").style.width=`${i/jobs.length*100}%`;progress.querySelector("strong").textContent=`Creating and replaying ${i+1} of ${jobs.length}…`;await createCryptoStrategy(jobs[i],risk,days,pick(assets));}modal.close();await refreshWorkspace("crypto");}catch(error){$("#crypto-batch-v3-message").textContent=error.message||"Batch creation failed";button.disabled=false;}});
}

async function deleteBot(botId, button) {
  button.disabled = true; const { error } = await supabase.from("bg_bots").delete().eq("id", botId); if (error) { button.disabled = false; console.error("Bot removal failed", error); return; } await refreshWorkspace();
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
    await autoBacktest(childId, marketDays); await refreshWorkspace("bots");
  } catch (error) {
    console.error("Child bot creation failed", error); if (childId) await supabase.from("bg_bots").delete().eq("id", childId); button.disabled = false; button.classList.remove("working"); button.title = `Child failed: ${error.message || "try again"}`; setTimeout(() => button.title = originalTitle, 5000);
  }
}

function botsBelowThreshold(threshold = 2, scope = "securities") {
  return bots.filter((bot) => (scope === "crypto" ? bot.asset_class === "crypto" : bot.asset_class !== "crypto")).filter((bot) => {
    return smartPruneAssessment(bot, threshold).eligible;
  });
}

function smartPruneAssessment(bot, threshold = 2) {
  const summary = backtestSummary.get(bot.id) || {}, confidence = botConfidence(bot), paper = paperPerformance.get(bot.id) || {}, result = bot.asset_class === "option" ? summary.estimatedPct : summary.profitPct, reasons = [];
  if (result == null || !Number.isFinite(Number(result))) reasons.push("No usable historical result");
  else if (Number(result) < threshold) reasons.push(`Return below ${threshold}%`);
  if (confidence.coverageDays >= 10 && confidence.validationAverage != null && confidence.validationAverage < 0) reasons.push("Negative unseen validation");
  if (Number(summary.evaluatedRuns || 0) >= 3 && Number(summary.positiveRuns || 0) / Number(summary.evaluatedRuns) < .4) reasons.push("Profitable in fewer than 40% of test runs");
  if (confidence.coverageDays >= 10 && Number(summary.maxDrawdown || 0) > Math.max(10, Math.abs(Number(result || 0)) * 2)) reasons.push("Drawdown is disproportionate to return");
  if (Number(paper.fill_count || 0) >= 10 && Number(paper.total_pnl || 0) < 0) reasons.push("Negative observed paper P&L after 10+ fills");
  return { eligible: reasons.length > 0, reasons };
}

function updatePruneButton() {
  const button = $("#prune-bots"); if (!button) return;
  const count = botsBelowThreshold().length;
  button.disabled = count === 0;
  button.textContent = count ? `Smart prune & clean up (${count})` : "Smart prune & clean up";
  button.title = count ? `Remove ${count} weak bot${count === 1 ? "" : "s"}, cancel unmanaged orders, and close wholly unmanaged positions` : "No bots currently meet the evidence-based pruning rules";
}

async function pruneUnderperformingBots(scope = "securities") {
  const button = scope === "crypto" ? document.querySelector("[data-prune-crypto]") : $("#prune-bots");
  const candidates = botsBelowThreshold(2,scope); if (!candidates.length) return;
  button.disabled = true; button.textContent = `Smart pruning ${candidates.length}…`;
  const { error } = await supabase.from("bg_bots").delete().in("id", candidates.map((bot) => bot.id));
  if (error) { console.error("Bulk bot removal failed", error); button.textContent = "Removal failed — retry"; button.disabled = false; return; }
  button.textContent = "Cleaning unmanaged exposure…";
  const cleanup = await cleanupUnmanagedBrokerExposure((message) => { if (button.isConnected) button.textContent = message; });
  await refreshWorkspace(scope === "crypto" ? "crypto" : currentView);
  const failures = cleanup.order_failures + cleanup.position_failures;
  showPwaNotice(`Pruned ${candidates.length} bot${candidates.length===1?"":"s"}; canceled ${cleanup.orders_canceled} order${cleanup.orders_canceled===1?"":"s"} and closed ${cleanup.positions_closed} position${cleanup.positions_closed===1?"":"s"}${failures?`; ${failures} cleanup action${failures===1?"":"s"} could not complete`:""}.`);
}

function formatDuration(seconds) {
  const days = Math.floor(Number(seconds || 0) / 86400); const hours = Math.floor((Number(seconds || 0) % 86400) / 3600);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h` : "Not yet";
}

function walkForwardBlock(result) {
  const holdout = result?.walk_forward; if (!holdout?.available) return `<div class="callout muted"><strong>Walk-forward validation unavailable</strong><br>${escapeHtml(holdout?.reason || "Run at least two market days to create a chronological holdout.")}</div>`;
  const optionEstimate = result.status === "signal_only", value = optionEstimate ? holdout.validation_estimated_return_pct : holdout.validation_return_pct;
  return `<div class="walk-forward"><div><span class="eyebrow">UNSEEN HOLDOUT</span><h3>${holdout.training_days} training days → ${holdout.validation_days} validation days</h3><p>The final 30% was kept chronologically separate. This is a robustness check, not a guarantee of future performance.</p></div><div class="walk-forward-score ${value > 0 ? "profit" : value < 0 ? "loss" : ""}"><span>${optionEstimate ? "Estimated validation return" : "Validation return"}</span><strong>${value == null ? "—" : pct(value)}</strong><small>${holdout.validation_signal_count || 0} signals · ${holdout.validation_trade_count || 0} trades · from ${escapeHtml(holdout.validation_start)}</small></div></div>`;
}

function executionExampleTable(bot, rule = {}, steps = [], spread = null, marketPrice = null) {
  const conditions = rule.conditions || [], conditionText = conditions.length ? conditions.map((condition) => `${conditionDefinition(condition.type)[1]} (${escapeHtml(condition.timeframe || "current")})`).join(` ${escapeHtml(rule.operator || "AND")} `) : "No structured entry condition";
  const rows = [{ step: 1, stage: "Signal check", trigger: conditionText, action: "Wait; submit nothing until the complete rule passes", example: `${conditions.length || 0} condition${conditions.length===1?"":"s"} evaluated` }];
  if (spread) {
    rows.push({ step: 2, stage: "Contract selection", trigger: `${spread.min_dte}–${spread.max_dte} DTE · target delta ${Number(spread.short_delta_target).toFixed(2)}`, action: `Build ${escapeHtml(spread.spread_type.replaceAll("_"," "))}`, example: `${spread.contracts} contract${Number(spread.contracts)===1?"":"s"} · ${money(spread.target_width)} width` });
    rows.push({ step: 3, stage: "Entry", trigger: `${spread.premium_type === "credit" ? "Credit at least" : "Debit no more than"} ${money(spread.target_premium || spread.minimum_credit)}`, action: "Submit the defined-risk paper order", example: `Maximum modeled risk ${money(spread.max_risk || bot.max_allocation)}` });
    rows.push({ step: 4, stage: "Profit exit", trigger: `${pct(spread.profit_close_pct)} of target profit captured`, action: "Close the option structure", example: `Also exit by ${spread.exit_dte} DTE` });
    rows.push({ step: 5, stage: "Risk exit", trigger: spread.loss_close_multiple == null ? "Saved risk limit" : `${Number(spread.loss_close_multiple).toFixed(2)}× entry premium loss`, action: "Close the structure at the available market", example: "Fill can differ from the trigger" });
  } else {
    const ordered = (steps || []).length ? steps : [{ step_number: 0, deviation_pct: 0, order_amount: bot.max_allocation }];
    ordered.forEach((order, index) => { const deviation = Number(order.deviation_pct || 0), illustrativePrice = Number(marketPrice) > 0 ? Number(marketPrice) * (1 - deviation / 100) : null, quantity = illustrativePrice ? Number(order.order_amount) / illustrativePrice : null; rows.push({ step: index + 2, stage: index ? `Averaging order ${index}` : "Initial entry", trigger: index ? `${pct(deviation)} below the reference entry` : "Entry conditions become true", action: `${bot.direction === "short" ? "Sell" : "Buy"} ${money(order.order_amount)}`, example: illustrativePrice ? `At ~${money(illustrativePrice)}: ~${quantity.toFixed(quantity < 1 ? 4 : 2)} shares` : "Quantity uses the available paper price" }); });
    rows.push({ step: rows.length + 1, stage: "Profit exit", trigger: bot.take_profit_pct ? `${pct(bot.take_profit_pct)} above blended cost` : "Strategy-specific target", action: "Close the paper position", example: "Uses the position's blended average entry" });
    rows.push({ step: rows.length + 1, stage: "Protective exit", trigger: bot.stop_loss_pct ? `${pct(bot.stop_loss_pct)} adverse move` : "Saved strategy risk policy", action: "Close at the available market", example: "Gaps and slippage can exceed the trigger" });
  }
  rows.push({ step: rows.length + 1, stage: "Cooldown", trigger: "After the position closes", action: "Block immediate re-entry", example: `${Math.round(Number(bot.cooldown_seconds || 0) / 60).toLocaleString()} minutes` });
  return `<h3 class="detail-title">How this bot works · illustrated example</h3><div class="execution-example"><table><thead><tr><th>#</th><th>Stage</th><th>Trigger</th><th>Bot action</th><th>Example</th></tr></thead><tbody>${rows.map((row)=>`<tr><td>${row.step}</td><td><strong>${escapeHtml(row.stage)}</strong></td><td>${row.trigger}</td><td>${escapeHtml(row.action)}</td><td>${escapeHtml(row.example)}</td></tr>`).join("")}</tbody></table></div><p class="benchmark-note">Illustrative translation of the saved rules using the latest available price where possible. It is not a quote, forecast, or pending order.</p>`;
}

async function showBotDetails(botId) {
  const bot = bots.find((item) => item.id === botId); if (!bot) return;
  const rule = bot.start_condition || {}; const conditions = rule.conditions || [];
  const [{ data: steps }, { data: spread }, { data: recentTests }, insights] = await Promise.all([
    supabase.from("bg_averaging_steps").select("step_number,deviation_pct,order_amount").eq("bot_id", bot.id).order("step_number"),
    supabase.from("bg_option_spreads").select("*").eq("bot_id", bot.id).maybeSingle(),
    supabase.from("bg_backtests").select("id,status,start_at,end_at,duration_seconds,net_pnl,return_pct,max_drawdown_pct,trade_count,win_count,loss_count,signal_count,estimated_pnl,estimated_return_pct,estimate_low_pct,estimate_high_pct,estimate_confidence,market_regime,market_return_pct,volatility_label,daily_regimes,walk_forward,created_at").eq("bot_id", bot.id).in("status", ["completed", "signal_only"]).order("created_at", { ascending: false }).limit(8),
    invoke("ticker-insights", { symbol: bot.symbol }).catch((error) => ({ error: error.message || "Ticker information unavailable" })),
  ]);
  const generatedValues = spread ? `<h3 class="detail-title">Generated spread settings</h3><div class="detail-grid"><div><span>Structure</span><strong>${escapeHtml(spread.spread_type.replaceAll("_", " "))}</strong></div><div><span>Expiration</span><strong>${spread.min_dte}–${spread.max_dte} DTE</strong></div><div><span>Short delta</span><strong>${Number(spread.short_delta_target).toFixed(2)}</strong></div><div><span>Width</span><strong>${money(spread.target_width)}</strong></div><div><span>Minimum credit</span><strong>${money(spread.minimum_credit)}</strong></div><div><span>Contracts</span><strong>${spread.contracts}</strong></div><div><span>Profit close</span><strong>${pct(spread.profit_close_pct)}</strong></div><div><span>Exit</span><strong>${spread.exit_dte} DTE</strong></div></div>` : steps?.length ? `<h3 class="detail-title">Generated order schedule</h3><table class="schedule"><thead><tr><th>Order</th><th>Deviation</th><th>Amount</th></tr></thead><tbody>${steps.map((step) => `<tr><td>${step.step_number ? `Averaging ${step.step_number}` : "Initial"}</td><td>-${pct(step.deviation_pct)}</td><td>${money(step.order_amount)}</td></tr>`).join("")}</tbody></table>` : "";
  const randomizedAudit = Object.entries(rule.randomized_fields || {}).map(([key, value]) => `<span><b>${escapeHtml(key)}:</b> ${escapeHtml(value)}</span>`).join("");
  const generated = rule.generated_strategy ? `<div class="callout"><strong>Generated configuration</strong><br>Curated template: ${escapeHtml(rule.generated_strategy.replaceAll("_", " "))}. Bounded random values are recorded below.${randomizedAudit ? `<div class="randomized-list">${randomizedAudit}</div>` : ""}</div>` : "";
  const history = recentTests?.length ? `<div class="test-history">${recentTests.map((test) => { const validation = test.status === "signal_only" ? test.walk_forward?.validation_estimated_return_pct : test.walk_forward?.validation_return_pct; return `<div><div><strong>${new Date(test.start_at).toLocaleDateString()} – ${new Date(test.end_at).toLocaleDateString()}</strong><span>${escapeHtml(test.market_regime || "Unclassified")} · ${escapeHtml(test.volatility_label || "Unknown")} volatility · market ${pct(test.market_return_pct)}${validation == null ? "" : ` · unseen ${pct(validation)}`}</span></div><div class="test-outcome"><strong>${test.status === "signal_only" ? (test.estimated_return_pct == null ? `${test.signal_count} signals` : `~${pct(test.estimated_return_pct)}`) : money(test.net_pnl)}</strong><span>${test.status === "signal_only" ? (test.estimated_return_pct == null ? "No estimate" : `${money(test.estimated_pnl)} modeled · ${pct(test.estimate_low_pct)} to ${pct(test.estimate_high_pct)}`) : `${pct(test.return_pct)} bot return`}</span></div></div>`; }).join("")}</div>` : `<div class="empty compact"><strong>No completed backtests yet</strong></div>`;
  const latestComparison = recentTests?.[0], botReturn = latestComparison?.status === "signal_only" ? latestComparison?.estimated_return_pct : latestComparison?.return_pct, holdReturn = latestComparison?.market_return_pct, comparisonAvailable = botReturn != null && holdReturn != null, excessReturn = comparisonAvailable ? Number(botReturn) - Number(holdReturn) : null;
  const benchmarkComparison = latestComparison ? `<h3 class="detail-title">Bot vs. buy-and-hold</h3><div class="benchmark-comparison"><div class="benchmark-period"><span>Latest matched test period</span><strong>${new Date(latestComparison.start_at).toLocaleDateString()} – ${new Date(latestComparison.end_at).toLocaleDateString()}</strong><small>${escapeHtml(latestComparison.market_regime || "Unclassified")} · ${escapeHtml(latestComparison.volatility_label || "Unknown")} volatility</small></div><div><span>${latestComparison.status === "signal_only" ? "Modeled bot return" : "Bot return"}</span><strong class="${Number(botReturn) > 0 ? "profit" : Number(botReturn) < 0 ? "loss" : ""}">${botReturn == null ? "—" : pct(botReturn)}</strong></div><div><span>Buy-and-hold ${escapeHtml(bot.symbol)}</span><strong class="${Number(holdReturn) > 0 ? "profit" : Number(holdReturn) < 0 ? "loss" : ""}">${holdReturn == null ? "—" : pct(holdReturn)}</strong></div><div><span>Excess return</span><strong class="${Number(excessReturn) > 0 ? "profit" : Number(excessReturn) < 0 ? "loss" : ""}">${excessReturn == null ? "—" : `${excessReturn >= 0 ? "+" : ""}${pct(excessReturn)}`}</strong><small>${excessReturn == null ? "Comparison unavailable" : excessReturn >= 0 ? "Bot outperformed the underlying" : "Holding the underlying performed better"}</small></div></div><p class="benchmark-note">${latestComparison.status === "signal_only" ? "Option strategy return is a low-confidence replay estimate; the benchmark is the underlying ticker, not historical option-chain performance." : "Uses the exact same test dates. Results exclude fees, slippage, taxes, and dividends and are not a forecast."}</p>` : `<h3 class="detail-title">Bot vs. buy-and-hold</h3><div class="empty compact"><strong>Run a backtest to create a matched-period comparison.</strong></div>`;
  const evaluatedWindows = (recentTests || []).map((test) => ({ bot: test.status === "signal_only" ? test.estimated_return_pct : test.return_pct, hold: test.market_return_pct })).filter((test) => test.bot != null && test.hold != null), positiveWindows = evaluatedWindows.filter((test) => Number(test.bot) > 0).length, winningWindows = evaluatedWindows.filter((test) => Number(test.bot) > Number(test.hold)).length;
  const closes = (latestComparison?.daily_regimes || []).map((day) => Number(day.close_price)).filter((value) => value > 0), holdDrawdown = closes.reduce((state, value) => ({ peak: Math.max(state.peak, value), max: Math.max(state.max, state.peak ? (state.peak - value) / state.peak * 100 : 0) }), { peak: 0, max: 0 }).max, botDrawdown = latestComparison?.max_drawdown_pct, returnToDrawdown = botReturn != null && Number(botDrawdown) > 0 ? Number(botReturn) / Number(botDrawdown) : null;
  const observed = paperPerformance.get(bot.id) || {}, observedReturn = Number(bot.max_allocation) && Number(observed.fill_count || 0) ? Number(observed.total_pnl || 0) / Number(bot.max_allocation) * 100 : null, executionGap = botReturn != null && observedReturn != null ? observedReturn - Number(botReturn) : null, prune = smartPruneAssessment(bot);
  const decisionDiagnostics = `<h3 class="detail-title">Robustness and execution reality</h3><div class="decision-diagnostics"><div><span>Bot max drawdown</span><strong class="${Number(botDrawdown) > 10 ? "loss" : ""}">${botDrawdown == null ? "—" : pct(botDrawdown)}</strong><small>Latest matched run</small></div><div><span>Underlying max drawdown</span><strong>${closes.length > 1 ? pct(holdDrawdown) : "—"}</strong><small>Daily closes in the same run</small></div><div><span>Return / drawdown</span><strong>${returnToDrawdown == null ? "—" : `${returnToDrawdown.toFixed(2)}×`}</strong><small>Higher is more efficient</small></div><div><span>Recent-window consistency</span><strong>${evaluatedWindows.length ? `${winningWindows}/${evaluatedWindows.length}` : "—"}</strong><small>Beat buy-and-hold · ${positiveWindows}/${evaluatedWindows.length || 0} positive</small></div><div><span>Observed paper return</span><strong class="${Number(observedReturn) > 0 ? "profit" : Number(observedReturn) < 0 ? "loss" : ""}">${observedReturn == null ? "—" : pct(observedReturn)}</strong><small>${Number(observed.fill_count || 0)} attributed fills</small></div><div><span>Paper vs. latest test gap</span><strong class="${Number(executionGap) > 0 ? "profit" : Number(executionGap) < 0 ? "loss" : ""}">${executionGap == null ? "—" : `${executionGap >= 0 ? "+" : ""}${pct(executionGap)}`}</strong><small>${executionGap == null ? "Needs attributed fills" : "Observed minus historical"}</small></div></div><p class="benchmark-note">Recent windows are saved test runs and may overlap. Treat consistency as supporting evidence, not independent trials.</p><div class="prune-assessment ${prune.eligible ? "eligible" : "keep"}"><strong>${prune.eligible ? "Smart-prune candidate" : "Currently passes smart-prune rules"}</strong><span>${prune.eligible ? prune.reasons.map((reason) => escapeHtml(reason)).join(" · ") : "No missing test, weak return, negative validation, poor consistency, excessive drawdown, or mature paper-loss trigger detected."}</span></div>`;
  const compact = (value) => value == null ? "—" : new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value));
  const premium = Number(spread?.target_premium || spread?.minimum_credit || 0), width = Number(spread?.target_width || 0), contracts = Number(spread?.contracts || 0), family = spread?.strategy_family;
  const maximumLoss = spread ? Number(spread.max_risk || bot.max_allocation) : Number(bot.max_allocation), plannedStopLoss = !spread && bot.stop_loss_pct ? Number(bot.max_allocation) * Number(bot.stop_loss_pct) / 100 : null;
  const maximumProfit = spread ? (family === "credit_spread" ? premium * 100 * contracts : family === "debit_spread" ? Math.max(0, width - premium) * 100 * contracts : null) : bot.take_profit_pct ? Number(bot.max_allocation) * Number(bot.take_profit_pct) / 100 : null;
  const riskMetrics = `<h3 class="detail-title">Risk and payoff</h3><div class="risk-callout">${spread ? "Defined-risk option structure based on saved width, premium, and contract count." : "A stop is an intended exit, not a guaranteed fill. A long stock position can still lose its full allocation during a severe gap or failed exit."}</div><div class="detail-grid risk-grid"><div><span>${spread ? "Modeled maximum loss" : "Capital at risk"}</span><strong class="loss">${money(maximumLoss)}</strong></div><div><span>${spread ? (family === "long_option" ? "Maximum profit" : "Modeled maximum profit") : "Target gain on allocation"}</span><strong>${maximumProfit == null ? "Open-ended" : money(maximumProfit)}</strong></div><div><span>Planned stop-loss exposure</span><strong>${spread ? (spread.loss_close_multiple == null ? "Not configured" : `${Number(spread.loss_close_multiple).toFixed(2)}× premium`) : plannedStopLoss == null ? "No automated stock stop" : `${money(plannedStopLoss)} at ${pct(bot.stop_loss_pct)}`}</strong></div><div><span>Reward / maximum-risk ratio</span><strong>${maximumProfit == null || !maximumLoss ? "Not bounded" : `${(maximumProfit / maximumLoss).toFixed(2)}×`}</strong></div></div>`;
  const confidence = botConfidence(bot), maturity = botMaturity(bot), paperForMaturity = paperPerformance.get(bot.id) || {}, gates = [{label:"10 unique test days",pass:confidence.coverageDays>=10},{label:`10 ${bot.asset_class==="option"?"signals":"trades"}`,pass:confidence.observations>=10},{label:"Positive unseen validation",pass:confidence.validationAverage>0},{label:"60+ confidence",pass:confidence.score>=60},{label:"10 paper fills",pass:confidence.fillCount>=10},{label:"Positive observed paper P&L",pass:Number(paperForMaturity.total_pnl||0)>0}], confidencePanel = `<h3 class="detail-title">Bot Confidence Score</h3><div class="confidence-panel"><div class="confidence-total"><strong>${confidence.score}<small>/100</small></strong><span>${confidence.label}</span><b class="maturity-badge ${maturity.id}">${escapeHtml(maturity.label)}</b><p>${escapeHtml(maturity.note)}</p></div><div class="confidence-breakdown">${Object.entries(confidence.breakdown).map(([label,value])=>`<div><span>${escapeHtml(label)}</span><div><i style="width:${Math.min(100,Math.abs(Number(value))/25*100)}%" class="${Number(value)<0?"penalty":""}"></i></div><strong>${Number(value)>=0?"+":""}${Number(value).toFixed(1)}</strong></div>`).join("")}</div><div class="confidence-evidence">${gates.map(gate=>`<span class="${gate.pass?"gate-pass":"gate-wait"}">${gate.pass?"✓":"○"} ${escapeHtml(gate.label)}</span>`).join("")}<span>${confidence.siblingCount} family candidates tested</span></div></div>`;
  const market = insights?.market, asset = insights?.asset, dayChange = market?.price && market?.previous_close ? (Number(market.price) / Number(market.previous_close) - 1) * 100 : null;
  const executionExample = executionExampleTable(bot, rule, steps || [], spread, market?.price);
  const tickerInfo = insights?.error ? `<h3 class="detail-title">Ticker intelligence</h3><div class="risk-callout muted">${escapeHtml(insights.error)}</div>` : `<h3 class="detail-title">${escapeHtml(bot.symbol)} ticker intelligence</h3><div class="ticker-heading"><div><strong>${escapeHtml(asset?.name || bot.symbol)}</strong><span>${escapeHtml([asset?.exchange, asset?.status].filter(Boolean).join(" · "))}</span></div><div><strong>${money(market?.price)}</strong><span class="${dayChange > 0 ? "profit" : dayChange < 0 ? "loss" : ""}">${dayChange == null ? "—" : `${dayChange >= 0 ? "+" : ""}${pct(dayChange)} today`}</span></div></div><div class="detail-grid ticker-grid"><div><span>5-day move</span><strong>${market?.change_5d_pct == null ? "—" : pct(market.change_5d_pct)}</strong></div><div><span>20-day move</span><strong>${market?.change_20d_pct == null ? "—" : pct(market.change_20d_pct)}</strong></div><div><span>Annualized volatility</span><strong>${pct(market?.annualized_volatility_pct)}</strong></div><div><span>60-day max drawdown</span><strong class="loss">${pct(market?.max_drawdown_60d_pct)}</strong></div><div><span>ATR (14 days)</span><strong>${money(market?.atr_14)} · ${pct(market?.atr_14_pct)}</strong></div><div><span>20-day average volume</span><strong>${compact(market?.average_volume_20d)}</strong></div><div><span>Latest relative volume</span><strong>${market?.relative_volume == null ? "—" : `${Number(market.relative_volume).toFixed(2)}×`}</strong></div><div><span>Current quote spread</span><strong>${market?.spread_pct == null ? "—" : pct(market.spread_pct)}</strong></div></div><div class="asset-flags"><span class="${asset?.tradable ? "on" : ""}">Tradable</span><span class="${asset?.fractionable ? "on" : ""}">Fractional</span><span class="${asset?.shortable ? "on" : ""}">Shortable</span><span class="${asset?.options_enabled ? "on" : ""}">Options</span><small>Alpaca IEX · as of ${market?.as_of ? new Date(market.as_of).toLocaleString() : "latest available"}</small></div>`;
  const newsItems = insights?.news || [], tickerNews = `<div class="section-head"><h3>Recent ${escapeHtml(bot.symbol)} news</h3><span class="subtle">Via Alpaca / Benzinga</span></div>${newsItems.length ? `<div class="ticker-news">${newsItems.map((item) => { const url = /^https?:\/\//i.test(item.url || "") ? item.url : "#"; return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"><span>${escapeHtml(item.source || "News")} · ${new Date(item.created_at).toLocaleString()}</span><strong>${escapeHtml(item.headline)}</strong>${item.summary ? `<p>${escapeHtml(item.summary)}</p>` : ""}</a>`; }).join("")}</div>` : `<div class="empty compact"><strong>No recent ticker-specific news returned</strong></div>`}`;
  $("#modal-content").innerHTML = `<div class="modal-head"><div><h3>${escapeHtml(bot.name)}</h3><p>${escapeHtml(bot.symbol)} · ${escapeHtml(bot.bot_type.replaceAll("_", " "))}</p></div><button type="button" class="icon-button" data-close-modal>×</button></div><div class="modal-body">${generated}${executionExample}${confidencePanel}<div class="detail-grid"><div><span>Maximum allocation</span><strong>${money(bot.max_allocation)}</strong></div><div><span>Take profit</span><strong>${bot.take_profit_pct ? pct(bot.take_profit_pct) : "Spread rule"}</strong></div><div><span>Stop loss</span><strong>${bot.stop_loss_pct ? pct(bot.stop_loss_pct) : "Defined by spread"}</strong></div><div><span>Session</span><strong>${escapeHtml(bot.session_policy)}</strong></div></div>${benchmarkComparison}${decisionDiagnostics}${riskMetrics}${tickerInfo}${tickerNews}<h3 class="detail-title">Start rules (${escapeHtml(rule.operator || "AND")})</h3><div class="rule-list">${conditions.map((condition) => `<div><strong>${escapeHtml(conditionDefinition(condition.type)[1])}</strong><span>${escapeHtml(condition.timeframe || "")} · ${escapeHtml(Object.entries(condition.parameters || {}).map(([key, value]) => `${key}: ${value}`).join(", "))}</span></div>`).join("") || "No structured rules saved."}</div>${generatedValues}<div class="section-head"><h3>${bot.asset_class === "option" ? "Signal-test history" : "Backtest history"}</h3><span class="subtle">${formatDuration(backtestSummary.get(bot.id)?.seconds || 0)} total coverage</span></div>${history}</div><div class="modal-foot"><button class="secondary" data-close-modal>Close</button><button class="primary" data-backtest="${bot.id}">${bot.asset_class === "option" ? "Test signals" : "Backtest"}</button></div>`;
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
      $("#backtest-result").innerHTML = `<div class="backtest-result"><div><span>Coverage</span><strong>${formatDuration(result.duration_seconds)}</strong></div><div><span>Signals</span><strong>${result.signal_count}</strong></div><div><span>${result.status === "signal_only" ? "Option P&L" : "Net P&L"}</span><strong>${result.status === "signal_only" ? "Not modeled" : money(result.net_pnl)}</strong></div><div><span>Bot return</span><strong>${result.return_pct == null ? "—" : pct(result.return_pct)}</strong></div><div><span>Market regime</span><strong>${escapeHtml(result.market_regime)}</strong></div><div><span>Market return</span><strong>${pct(result.market_return_pct)}</strong></div><div><span>Volatility</span><strong>${escapeHtml(result.volatility_label)}</strong></div><div><span>Trades</span><strong>${result.trade_count}</strong></div><div><span>Max drawdown</span><strong>${result.max_drawdown_pct == null ? "—" : pct(result.max_drawdown_pct)}</strong></div></div>${walkForwardBlock(result)}${result.daily_regimes?.length ? `<div class="daily-regimes"><h3>Day-by-day context</h3>${result.daily_regimes.map((day) => `<div><span>${escapeHtml(day.date)}</span><strong>${escapeHtml(day.regime)}</strong><span>${escapeHtml(day.volatility)} volatility</span><span>${pct(day.return_pct)}</span></div>`).join("")}</div>` : ""}`;
      button.textContent = "Run again"; button.disabled = false; await refreshWorkspace();
    } catch (error) { $("#backtest-message").textContent = error.message || "Backtest failed"; button.textContent = "Run backtest"; button.disabled = false; }
  });
}

let activityTimer = null;
async function closeMarketPosition(symbol,button){button.disabled=true;button.textContent="Closing…";try{await invoke("close-position",{symbol});await loadActivity();}catch(error){button.disabled=false;button.textContent="Close at market";button.title=error.message||"Unable to close position";alert(error.message||"Unable to close position");}}
async function cancelPendingOrder(orderId,button){button.disabled=true;button.textContent="Canceling…";try{await invoke("cancel-order",{orderId});await loadActivity();}catch(error){button.disabled=false;button.textContent="Cancel order";button.title=error.message||"Unable to cancel order";alert(error.message||"Unable to cancel order");}}
async function cleanupUnmanagedBrokerExposure(onProgress = () => {}) {
  const result = { orders_canceled: 0, order_failures: 0, positions_closed: 0, position_failures: 0 };
  onProgress("Finding unmanaged orders…");
  const snapshot = await invoke("portfolio-snapshot", {}).catch(() => ({ pending_orders: [] }));
  const orders = (snapshot.pending_orders || []).filter((order) => order.attribution === "unmanaged");
  for (let index = 0; index < orders.length; index++) { onProgress(`Canceling order ${index + 1} of ${orders.length}…`); try { await invoke("cancel-order", { orderId: orders[index].id }); result.orders_canceled++; } catch { result.order_failures++; } }
  onProgress("Rechecking position attribution…");
  const performance = await invoke("bot-performance", {}).catch(() => ({ position_attribution: [] }));
  const positions = (performance.position_attribution || []).filter((item) => item.classification === "unmanaged");
  for (let index = 0; index < positions.length; index++) { onProgress(`Closing position ${index + 1} of ${positions.length}…`); try { await invoke("close-position", { symbol: positions[index].symbol }); result.positions_closed++; } catch { result.position_failures++; } }
  return result;
}
async function closeAllUnmanagedPositions(button){
  button.disabled=true;button.textContent="Checking attribution…";const performance=await invoke("bot-performance",{}).catch(error=>({error:error.message,position_attribution:[]})),targets=(performance.position_attribution||[]).filter(item=>item.classification==="unmanaged"),failures=[];for(let index=0;index<targets.length;index++){button.textContent=`Closing ${index+1} of ${targets.length}…`;try{await invoke("close-position",{symbol:targets[index].symbol})}catch(error){failures.push(`${targets[index].symbol}: ${error.message||"failed"}`)}}await loadDashboard();showPwaNotice(failures.length?`Closed ${targets.length-failures.length} unmanaged positions; ${failures.length} could not close (often because the market is closed).`:`Closed ${targets.length} unmanaged position${targets.length===1?"":"s"}.`);
}
async function cancelAllUnmanagedOrders(button){
  button.disabled=true;button.textContent="Checking orders…";const snapshot=await invoke("portfolio-snapshot",{}).catch(error=>({error:error.message,pending_orders:[]})),targets=(snapshot.pending_orders||[]).filter(order=>order.attribution==="unmanaged"),failures=[];for(let index=0;index<targets.length;index++){button.textContent=`Canceling ${index+1} of ${targets.length}…`;try{await invoke("cancel-order",{orderId:targets[index].id})}catch(error){failures.push(targets[index].id)}}await loadDashboard();showPwaNotice(failures.length?`Canceled ${targets.length-failures.length} unmanaged orders; ${failures.length} could not be canceled.`:`Canceled ${targets.length} unmanaged order${targets.length===1?"":"s"}.`);
}
function fillAssetClass(fill, bot) {
  if (bot?.asset_class) return bot.asset_class;
  if (/\d{6}[CP]\d{8}$/.test(fill.symbol || "")) return "option";
  if ((fill.symbol || "").includes("/") || /^(BTC|ETH|SOL|DOGE|AVAX|LINK|LTC|BCH|UNI|AAVE|SHIB|DOT|MATIC)USD$/.test(fill.symbol || "")) return "crypto";
  return "equity";
}
async function renderActivityPositions(orderAttribution = new Map()){
  const snapshot=await invoke("portfolio-snapshot",{}).catch(error=>({error:error.message,positions:[]}));
  const unattributedOrders=(snapshot.pending_orders||[]).filter(order=>!orderAttribution.has(order.id)),unattributedFills=(snapshot.fills||[]).filter(fill=>!orderAttribution.has(fill.order_id));if(unattributedOrders.length||unattributedFills.length){const warning=document.createElement("div");warning.className="callout reconciliation-alert";warning.innerHTML=`<strong>External or unattributed broker activity</strong><br>${unattributedOrders.length} pending order${unattributedOrders.length===1?"":"s"} and ${unattributedFills.length} recent fill${unattributedFills.length===1?"":"s"} cannot currently be tied to a BotGarden bot. These may be manual Alpaca trades or older records outside the attribution window.`;content.querySelector(".activity-summary")?.insertAdjacentElement("afterend",warning);}
  const positions=(snapshot.positions||[]).filter(position=>position.asset_class===activityFilter),total=positions.reduce((sum,position)=>sum+Number(position.unrealized_pl||0),0),panel=document.createElement("section");panel.className="position-panel";
  const rows=positions.map(position=>`<div class="position-row"><div><strong>${escapeHtml(position.symbol)}</strong><span>${escapeHtml(position.side)} · ${Number(position.qty).toLocaleString(undefined,{maximumFractionDigits:8})}</span></div><div><span>Average entry</span><strong>${money(position.avg_entry_price)}</strong></div><div><span>Current price</span><strong>${money(position.current_price)}</strong></div><div><span>Market value</span><strong>${money(position.market_value)}</strong></div><div><span>Unrealized P&amp;L</span><strong class="${position.unrealized_pl>0?"profit":position.unrealized_pl<0?"loss":""}">${money(position.unrealized_pl)} · ${pct(position.unrealized_plpc)}</strong></div><button class="position-close" data-close-position="${escapeHtml(position.symbol)}">Close at market</button></div>`).join("");
  const body=snapshot.error?`<div class="callout">${escapeHtml(snapshot.error)}</div>`:rows?`<div class="position-list">${rows}</div>`:`<div class="empty compact"><strong>No open ${activityFilter} positions</strong></div>`;
  panel.innerHTML=`<div class="section-head"><h3>Open ${activityFilter==="equity"?"stock":activityFilter} positions</h3><div><strong class="${total>0?"profit":total<0?"loss":""}">${money(total)}</strong> <span class="subtle">unrealized P&amp;L · ${snapshot.as_of?new Date(snapshot.as_of).toLocaleTimeString():"unavailable"}</span></div></div>${body}`;(content.querySelector(".reconciliation-alert")||content.querySelector(".activity-summary"))?.insertAdjacentElement("afterend",panel);
  const pending=(snapshot.pending_orders||[]).filter(order=>order.asset_class===activityFilter),pendingPanel=document.createElement("section");
  const pendingRows=pending.map(order=>{const bot=orderAttribution.get(order.id),legs=(order.legs||[]).map(leg=>`${leg.side} ${leg.ratio_qty||1} ${leg.symbol}`).join(" · "),price=order.limit_price!=null?`Limit ${money(order.limit_price)}`:order.stop_price!=null?`Stop ${money(order.stop_price)}`:"Market price",size=order.notional!=null?money(order.notional):`${Number(order.quantity).toLocaleString(undefined,{maximumFractionDigits:8})} qty`;return `<div class="pending-order-row"><div><strong>${escapeHtml(order.symbol)}</strong><span>${bot?escapeHtml(bot.name):"External or unattributed order"}</span>${legs?`<small>${escapeHtml(legs)}</small>`:""}</div><div><span>Order</span><strong>${escapeHtml(order.side||"multi-leg")} · ${escapeHtml((order.order_type||"").replaceAll("_"," "))}</strong></div><div><span>Size</span><strong>${size}</strong><small>${price}</small></div><div><span>Status</span><strong>${escapeHtml(order.status.replaceAll("_"," "))}</strong><small>${new Date(order.submitted_at).toLocaleString()}</small></div><button class="order-cancel" data-cancel-order="${escapeHtml(order.id)}">Cancel order</button></div>`;}).join("");
  pendingPanel.innerHTML=`<div class="section-head"><h3>Pending orders</h3><span class="subtle">${pending.length} cancelable ${activityFilter} order${pending.length===1?"":"s"}</span></div>${pendingRows?`<div class="pending-order-list">${pendingRows}</div>`:`<div class="empty compact"><strong>No pending ${activityFilter} orders</strong></div>`}`;panel.insertAdjacentElement("afterend",pendingPanel);
  const fills=(snapshot.fills||[]).map(fill=>({fill,bot:orderAttribution.get(fill.order_id)})).filter(({fill,bot})=>fillAssetClass(fill,bot)===activityFilter).slice(0,20),fillPanel=document.createElement("section");
  const fillRows=fills.map(({fill,bot})=>`<div class="fill-row"><div><strong>${escapeHtml(fill.symbol)}</strong><span>${bot?escapeHtml(bot.name):"External or unattributed order"}</span></div><div><span>Side</span><strong class="fill-side ${fill.side==="sell"?"loss":"profit"}">${escapeHtml(fill.side)}</strong></div><div><span>Quantity</span><strong>${Number(fill.quantity).toLocaleString(undefined,{maximumFractionDigits:8})}</strong></div><div><span>Fill price</span><strong>${money(fill.price)}</strong></div><div><span>Executed</span><strong>${new Date(fill.transaction_time).toLocaleString()}</strong></div></div>`).join("");
  fillPanel.innerHTML=`<div class="section-head"><h3>Recent broker fills</h3><span class="subtle">Latest 20 · attributed by Alpaca order ID</span></div>${fillRows?`<div class="fill-list">${fillRows}</div>`:`<div class="empty compact"><strong>No recent ${activityFilter} fills</strong></div>`}`;pendingPanel.insertAdjacentElement("afterend",fillPanel);
}
async function loadActivity() {
  const [{ data: statuses }, { data: allActivityBots }, { data: activityOrders }, { data: activityTrades }, { data: activityRuns }, { data: orderEvents }] = await Promise.all([supabase.from("bg_bot_status").select("*").order("checked_at", { ascending: false }), supabase.from("bg_bots").select("id,name,symbol,status,asset_class").order("created_at", { ascending: false }),supabase.from("bg_orders").select("broker_order_id,trade_id").not("broker_order_id","is",null).order("created_at",{ascending:false}).limit(500),supabase.from("bg_trades").select("id,run_id").limit(500),supabase.from("bg_bot_runs").select("id,bot_id").limit(500),supabase.from("bg_bot_events").select("bot_id,details").order("created_at",{ascending:false}).limit(500)]); const statusByBot = new Map((statuses || []).map((status) => [status.bot_id, status])),activityBots=(allActivityBots||[]).filter(bot=>bot.asset_class===activityFilter),botById=new Map((allActivityBots||[]).map(bot=>[bot.id,bot])),runBot=new Map((activityRuns||[]).map(run=>[run.id,run.bot_id])),tradeBot=new Map((activityTrades||[]).map(trade=>[trade.id,runBot.get(trade.run_id)])),orderAttribution=new Map((activityOrders||[]).map(order=>[order.broker_order_id,botById.get(tradeBot.get(order.trade_id))]));
  (orderEvents||[]).forEach(event=>{if(event.details?.broker_order_id&&!orderAttribution.has(event.details.broker_order_id))orderAttribution.set(event.details.broker_order_id,botById.get(event.bot_id));});
  const cards = (activityBots || []).map((bot) => { const status = statusByBot.get(bot.id); if (bot.status !== "active") return `<article class="decision-card muted"><div class="decision-head"><div><strong>${escapeHtml(bot.name)}</strong><span>${escapeHtml(bot.symbol)} · OFF</span></div><b>Paused</b></div><p>This bot is OFF and was not evaluated in the current cycle.</p></article>`; if (!status) return `<article class="decision-card"><div class="decision-head"><div><strong>${escapeHtml(bot.name)}</strong><span>${escapeHtml(bot.symbol)} · waiting</span></div><b>Pending</b></div><p>Waiting for its first scheduled evaluation.</p></article>`; const conditions = status.details?.conditions || []; return `<article class="decision-card ${status.reason_code === "error" ? "error" : status.reason_code.includes("submitted") ? "success" : ""}"><div class="decision-head"><div><strong>${escapeHtml(bot.name)}</strong><span>${escapeHtml(bot.symbol)} · checked ${new Date(status.checked_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span></div><b>${escapeHtml(status.reason_code.replaceAll("_", " "))}</b></div><p>${escapeHtml(status.message)}</p>${conditions.length ? `<div class="condition-status">${conditions.map((condition) => `<span class="${condition.passed ? "pass" : "fail"}" title="Requires ${escapeHtml(condition.required || "configured rule")}">${condition.passed ? "✓" : "×"} ${escapeHtml(conditionDefinition(condition.type)[1])}<small>${escapeHtml(condition.measured || "No measurement")} · needs ${escapeHtml(condition.required || "configured rule")}</small></span>`).join("")}</div>` : ""}${status.details?.last_price ? `<div class="subtle">Last price ${money(status.details.last_price)} · ${escapeHtml(status.details.timeframe || "")}</div>` : ""}</article>`; }).join("");
  content.innerHTML = `<div class="activity-summary"><div><span class="eyebrow">LATEST AUTOMATION CHECK</span><h3>Why each bot acted—or waited</h3><p>Entries are evaluated every five minutes. Open-position risk and exits are checked every minute. This page refreshes automatically every 30 seconds.</p></div><button class="secondary" id="refresh-activity">Refresh now</button></div><div class="decision-list">${cards || `<div class="empty"><h3>No bots configured</h3></div>`}</div>`; $("#refresh-activity")?.addEventListener("click", loadActivity); clearTimeout(activityTimer); activityTimer = setTimeout(() => document.querySelector('[data-view="activity"]')?.classList.contains("active") && loadActivity(), 30000);
  await renderActivityPositions(orderAttribution);
}

function switchView(view) {
  currentView = view;
  if (view !== "activity") { clearTimeout(activityTimer); activityTimer = null; }
  const showSecuritiesActions = view === "bots"; ["#prune-bots", "#random-ten", "#random-bot", "#stock-strategy", "#random-option-bot", "#new-bot"].forEach((selector) => $(selector)?.classList.toggle("hidden", !showSecuritiesActions));
  $("#activity-tabs")?.classList.toggle("hidden",view!=="activity");
  document.querySelectorAll(".nav-item[data-view]").forEach((el) => el.classList.toggle("active", el.dataset.view === view));
  $("#page-title").textContent = ({ dashboard: "Overview", bots: "Stocks & Options", crypto: "Crypto", activity: "Activity", settings: "Settings" })[view];
  if (view === "dashboard") return loadDashboard();
  if (view === "bots") return renderSecuritiesWorkspace();
  if (view === "crypto") return renderCrypto();
  if (view === "activity") return loadActivity();
  return loadSettings();
}

async function setOperationsControl(action, button) {
  button.disabled = true; const original = button.textContent; button.textContent = action === "resume" ? "Resuming…" : "Pausing…";
  try { const result = await invoke("operations-control", { action: action === "resume" ? "resume" : "pause", cancelPending: action === "pause_cancel" }); await loadSettings(); if (action === "pause_cancel") showPwaNotice(`Entries paused. ${result.canceled_pending_orders || 0} tracked pending order${result.canceled_pending_orders === 1 ? "" : "s"} canceled.`); }
  catch (error) { button.disabled = false; button.textContent = original; showPwaNotice(error.message || "Emergency control failed"); }
}

async function loadSettings() {
  content.innerHTML = `<div class="empty compact"><strong>Loading operational controls…</strong></div>`; const operational = await invoke("operations-control", { action: "status" }).catch((error) => ({ health: [], error: error.message })), paused = !!operational.entries_paused;
  content.innerHTML = `<div class="section-head"><h3>Emergency controls</h3><span class="status ${paused ? "paused" : ""}">${paused ? "ENTRIES PAUSED" : "ENTRIES ENABLED"}</span></div><div class="card emergency-control"><div><h3>${paused ? "New entries are stopped" : "Paper entries are enabled"}</h3><p>The one-minute risk monitor and automated exits continue even while entries are paused.</p></div><div class="emergency-actions">${paused ? `<button class="primary" data-operations-control="resume">Resume new entries</button>` : `<button class="secondary" data-operations-control="pause">Pause entries</button><button class="danger-button" data-operations-control="pause_cancel">Pause + cancel BotGarden pending orders</button>`}</div></div>${workerHealthBlock(operational)}<div class="section-head"><h3>Broker connections</h3></div><div class="card connection-card"><p>Connect an Alpaca paper account using credentials created in your Alpaca dashboard.</p><button class="primary" data-connect>Connect Alpaca</button></div><div class="section-head"><h3>Installable app</h3></div><div class="card connection-card"><div><h3>Install BotGarden</h3><p>Run in a standalone window with a home-screen icon and an offline application shell. Trading data still requires a connection.</p></div><button class="secondary" data-install-pwa>${matchMedia("(display-mode: standalone)").matches ? "Installed" : "Install app"}</button></div><div class="section-head"><h3>Paper execution capacity</h3></div><div class="settings-grid"><div class="card"><span class="eyebrow">TWO-SPEED SCHEDULE</span><h3>1-minute risk · 5-minute entries</h3><p>Open-position exits are checked every minute. New entries remain on completed strategy-bar boundaries.</p></div><div class="card"><span class="eyebrow">RETENTION</span><h3>30-day decision log</h3><p>Detailed bot events are removed daily after 30 days. Trades, orders, backtests, and P&amp;L attribution remain intact.</p></div><div class="card"><span class="eyebrow">ORDER SAFETY</span><h3>Risk and exposure gates</h3><p>Orders fail closed if liquidity, premium, width, risk, or contract checks fail.</p></div><div class="card"><span class="eyebrow">OPTION HISTORY</span><h3>Signal-only historical validation</h3><p>Historical chain-and-Greeks snapshots remain unavailable from the current feed, so BotGarden does not invent option P&amp;L.</p></div></div>`;
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
  ["trailing_reversal", "Pullback + rebound confirmation", [["pullback_pct", "Pullback (%)", "number", "3"], ["rebound_pct", "Rebound (%)", "number", "1"], ["lookback_bars", "Lookback bars", "number", "24"]]],
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
  ["atr_percentile", "ATR volatility regime", [["period", "ATR period", "number", "14"], ["lookback", "Percentile lookback", "number", "60"], ["operator", "Regime", "select", "above:Above percentile|below:Below percentile"], ["value", "Percentile", "number", "70"]]],
  ["bollinger_bandwidth", "Bollinger squeeze / expansion", [["period", "Band period", "number", "20"], ["lookback", "Percentile lookback", "number", "60"], ["operator", "Regime", "select", "above:Expanding / above percentile|below:Squeeze / below percentile"], ["value", "Percentile", "number", "30"]]],
  ["relative_strength", "Relative strength vs benchmark", [["benchmark", "Benchmark", "select", "SPY:SPY|QQQ:QQQ|IWM:IWM"], ["lookback", "Lookback bars", "number", "12"], ["operator", "Direction", "select", "above:Outperforming|below:Underperforming"], ["value", "Excess return (%)", "number", "0"]]],
  ["market_regime", "Broad-market trend regime", [["benchmark", "Benchmark", "select", "SPY:SPY|QQQ:QQQ|IWM:IWM"], ["fast", "Fast EMA", "number", "20"], ["slow", "Slow EMA", "number", "50"], ["operator", "Regime", "select", "bullish:Bullish|bearish:Bearish"]]],
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
  if (next.type === "atr_percentile") { p.period = pick([10, 14, 20]); p.lookback = pick([40, 60, 100]); p.value = pick([30, 40, 60, 70]); changed["ATR regime"] = `${p.operator} ${p.value}th percentile`; }
  if (next.type === "bollinger_bandwidth") { p.period = pick([18, 20, 22]); p.lookback = pick([40, 60, 100]); p.value = pick([20, 25, 30, 70]); changed["Volatility regime"] = `${p.operator === "below" ? "squeeze" : "expansion"} at ${p.value}th percentile`; }
  if (next.type === "relative_strength") { p.benchmark = pick(["SPY", "QQQ"]); p.lookback = pick([6, 12, 20]); p.value = randomStep(-.25, .75, .25); changed["Relative strength"] = `${p.operator} ${p.benchmark} by ${p.value}%`; }
  if (next.type === "market_regime") { const pair = pick([[9, 21], [20, 50], [50, 100]]); p.fast = pair[0]; p.slow = pair[1]; p.benchmark = pick(["SPY", "QQQ"]); changed["Market regime"] = `${p.operator} ${p.benchmark} EMA ${p.fast}/${p.slow}`; }
  if (next.type === "gap") { p.value = randomStep(1.25, 4, .25); changed.Gap = `${p.value}%`; }
  return { condition: next, changed };
}

function varyConditionCount(conditions, bias, randomized) {
  const roll = Math.random(), target = roll < .15 ? 1 : roll < .75 ? 2 : 3;
  const confirmationTypes = new Set(["relative_volume", "vwap", "atr", "atr_percentile", "bollinger_bandwidth", "relative_strength", "market_regime"]), primary = conditions.find((condition) => !confirmationTypes.has(condition.type)) || conditions[0];
  let selected = target === 1 ? [primary] : conditions.length > target ? [primary, ...conditions.filter((condition) => condition !== primary).sort(() => Math.random() - .5).slice(0, target - 1)] : [...conditions];
  const timeframe = primary?.timeframe || "15Min", directional = bias === "bearish" ? "below" : "above", additions = [
    { type: "market_regime", timeframe, parameters: { benchmark: "SPY", fast: 20, slow: 50, operator: bias === "bearish" ? "bearish" : "bullish" } },
    { type: "relative_strength", timeframe, parameters: { benchmark: "SPY", lookback: 12, operator: directional, value: 0 } },
    { type: "atr_percentile", timeframe, parameters: { period: 14, lookback: 60, operator: "above", value: 40 } },
    { type: "bollinger_bandwidth", timeframe, parameters: { period: 20, lookback: 60, operator: primary?.type === "opening_range" ? "above" : "below", value: primary?.type === "opening_range" ? 60 : 30 } },
    { type: "relative_volume", timeframe, parameters: { operator: "above", value: 1.2, lookback: 20 } },
    { type: "moving_average", timeframe, parameters: { average: "ema", fast: 9, slow: 21, operator: directional } },
    { type: "rsi", timeframe, parameters: { period: 14, operator: directional, value: bias === "bearish" ? 48 : 52 } },
  ].sort(() => Math.random() - .5);
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

async function backtestAllBots30Days(button) {
  if (batchBacktestRunning || !bots.length) return;
  batchBacktestRunning = true;
  button.disabled = true;
  button.textContent = "Preparing 30-day batch…";
  const targets = [...bots], end = new Date();
  end.setUTCDate(end.getUTCDate() - 1); end.setUTCHours(23, 59, 0, 0);
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - 30);
  modal.showModal();
  $("#modal-content").innerHTML = `<div class="modal-head"><div><h3>Backtesting the whole garden</h3><p>${targets.length} bots · previous 30 calendar days · options use signal-only validation</p></div></div><div class="modal-body"><div id="all-backtest-progress" class="bulk-progress"><span></span><strong>Starting…</strong></div><div class="batch-test-counts"><span><b id="batch-completed">0</b> completed</span><span><b id="batch-failed">0</b> failed</span></div><p class="form-message" id="all-backtest-message">Keep this page open while the batch runs.</p></div>`;
  let completed = 0, failed = 0;
  for (const bot of targets) {
    const progress = $("#all-backtest-progress");
    if (progress) { progress.querySelector("strong").textContent = `Testing ${bot.name} · ${completed + failed + 1} of ${targets.length}`; progress.querySelector("span").style.width = `${(completed + failed) / targets.length * 100}%`; }
    try { await invoke("backtest-bot", { botId: bot.id, start: start.toISOString(), end: end.toISOString() }); completed++; }
    catch (error) { failed++; console.warn(`Batch backtest failed for ${bot.name}`, error); }
    $("#batch-completed") && ($("#batch-completed").textContent = completed);
    $("#batch-failed") && ($("#batch-failed").textContent = failed);
  }
  batchBacktestRunning = false;
  await loadDashboard();
  $("#modal-content").innerHTML = `<div class="modal-head"><div><h3>Garden backtest complete</h3><p>Results are saved and rankings have been refreshed.</p></div><button type="button" class="icon-button" data-close-modal>×</button></div><div class="modal-body"><div class="batch-complete"><strong>${completed}</strong><span>bots completed across the previous 30 calendar days</span></div>${failed ? `<div class="callout">${failed} bot${failed === 1 ? "" : "s"} could not be tested. You can retry the batch or test those bots individually.</div>` : ""}</div><div class="modal-foot"><button class="primary" data-close-modal>Done</button></div>`;
}

async function showStockStrategyForm() {
  modal.showModal();
  $("#modal-content").innerHTML = `<form id="stock-strategy-form"><div class="modal-head"><div><h3>Create a specialized stock bot</h3><p>Purpose-built behavior instead of an ordinary DCA label.</p></div><button type="button" class="icon-button" data-close-modal>×</button></div><div class="modal-body"><div class="form-grid"><label>Strategy<select name="strategy"><option value="stock_grid">ATR-adaptive grid</option><option value="scheduled_accumulation">Scheduled accumulation</option><option value="smart_trailing">Smart trailing reversal</option></select></label><label>Ticker<input name="symbol" value="SPY" pattern="[A-Za-z.]{1,10}" required></label><label>Maximum allocation<input name="risk" type="number" min="50" step="25" value="500" required></label><label>Backtest market days<input name="days" type="number" min="1" max="60" value="5" required></label></div><div class="callout">Grid ranges use the ticker's current ATR. Scheduled accumulation spreads capital over time. Smart trailing waits for both a pullback and a rebound rather than buying a falling price immediately.</div><div class="strategy-roadmap"><div class="strategy-card"><strong>Pairs mean reversion</strong><span>Next: requires synchronized two-symbol fills and hedge-ratio accounting.</span></div><div class="strategy-card"><strong>Portfolio rebalancer</strong><span>Next: requires basket-level orders and portfolio drift state.</span></div><div class="strategy-card"><strong>Webhook signals</strong><span>Next: requires signed inbound endpoints and replay-safe event IDs.</span></div></div><p class="form-message" id="stock-strategy-message"></p></div><div class="modal-foot"><button type="button" class="secondary" data-close-modal>Cancel</button><button class="primary" type="submit">Create and backtest</button></div></form>`;
  $("#stock-strategy-form").addEventListener("submit", async (event) => {
    event.preventDefault(); const button=event.submitter,data=new FormData(event.currentTarget),strategy=String(data.get("strategy")),symbol=String(data.get("symbol")).toUpperCase(),risk=Number(data.get("risk"));button.disabled=true;button.textContent="Sizing strategy…";
    try {
      const insights=await invoke("ticker-insights",{symbol});const price=Number(insights.market?.price),atrPct=Number(insights.market?.atr_14_pct);if(!price||!atrPct)throw new Error("Current price and ATR are required for this ticker");
      const config=strategy==="stock_grid"?{range_pct:Math.max(2,Math.min(12,atrPct*pick([2.5,3,3.5]))),levels:pick([6,7,8,9,10]),order_amount:0}:strategy==="scheduled_accumulation"?{interval_days:pick([1,2,3,5]),installments:pick([4,5,6,8,10])}:{pullback_pct:Math.max(1,Math.min(8,atrPct*pick([1.5,2,2.5]))),rebound_pct:Math.max(.4,Math.min(3,atrPct*pick([.6,.8,1]))),lookback_bars:pick([12,18,24,30])};if(strategy==="stock_grid")config.order_amount=Math.max(10,Math.floor(risk/Math.ceil(config.levels/2)));
      config.exit_policy={trailing_activation_pct:randomStep(1.5,4,.5),trailing_distance_pct:randomStep(.75,2,.25),break_even_trigger_pct:randomStep(1,2.5,.5),break_even_floor_pct:.1,max_hold_hours:pick([6,12,24,48,72]),max_daily_drawdown_pct:pick([1.5,2,2.5,3]),max_stock_exposure_pct:pick([40,50,60])};
      const labels={stock_grid:"Adaptive Grid",scheduled_accumulation:"Scheduled Accumulator",smart_trailing:"Smart Trailing Reversal"};const conditions=strategy==="smart_trailing"?[{type:"trailing_reversal",timeframe:"5Min",parameters:config}]:[{type:"immediate",timeframe:strategy==="scheduled_accumulation"?"1Day":"15Min",parameters:{}}];
      const {data:bot,error}=await supabase.from("bg_bots").insert({user_id:session.user.id,name:`${symbol} ${labels[strategy]}`,bot_type:strategy==="stock_grid"?"grid":"signal",status:"active",broker:"alpaca",environment:"paper",asset_class:"equity",symbol,direction:"long",max_allocation:risk,max_active_trades:strategy==="stock_grid"?config.levels:1,start_condition:{operator:"AND",conditions,generated_strategy:strategy,strategy_config:config,randomized_fields:{Strategy:labels[strategy],...config}},take_profit_pct:strategy==="scheduled_accumulation"?12:strategy==="smart_trailing"?pick([3,4,5,6]):null,stop_loss_pct:strategy==="smart_trailing"?pick([2,3,4]):null,cooldown_seconds:strategy==="scheduled_accumulation"?config.interval_days*86400:300,session_policy:"regular"}).select().single();if(error)throw error;
      if(strategy==="stock_grid"){const half=config.range_pct/100;const{error:gridError}=await supabase.from("bg_grid_configs").insert({bot_id:bot.id,user_id:session.user.id,lower_price:price*(1-half),upper_price:price*(1+half),grid_levels:config.levels,order_amount:config.order_amount,spacing_mode:"geometric",recenter_enabled:true,fee_bps:1});if(gridError){await supabase.from("bg_bots").delete().eq("id",bot.id);throw gridError;}}
      button.textContent="Backtesting…";try{await autoBacktest(bot.id,Number(data.get("days")))}catch(error){console.warn("Specialized stock backtest failed",error)}securitiesFilter="equity";modal.close();await refreshWorkspace("bots");
    }catch(error){$("#stock-strategy-message").textContent=error.message||"Unable to create strategy";button.disabled=false;button.textContent="Create and backtest";}
  });
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
    securitiesFilter = "equity"; modal.close(); await refreshWorkspace("bots");
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
    securitiesFilter = "option"; modal.close(); await refreshWorkspace("bots");
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
    await refreshWorkspace("bots");
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
    securitiesFilter = data.get("assetClass"); modal.close(); await refreshWorkspace("bots");
  });
}

boot();
