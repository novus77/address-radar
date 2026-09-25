// @ts-nocheck
const state = {
  module: "traders",
  traders: [],
  candidates: [],
  candidateFunnel: {},
  aggregations: [],
  signals: [],
  identityQueue: [],
  identityForms: [],
  historicalTokens: [],
  historicalPartitions: [],
  historicalOperations: {},
  walletAnalyses: [],
  selectedWalletAnalysisId: null,
};

const $ = selector => document.querySelector(selector);
const workspace = $("#workspace");

const api = async (path, options = {}) => {
  const response = await fetch(`/api/v1/${path}`, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const payload = await response.json();
  if (!response.ok) throw new Error(response.status === 401 ? "开发者 Token 无效" : payload.message || payload.error || `请求失败：${response.status}`);
  return payload;
};
const apiV2 = async (path, options = {}) => {
  const response = await fetch(`/api/v2/${path}`, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message || payload.error || `请求失败：${response.status}`);
  return payload;
};

const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const text = (value, fallback = "--") => value === null || value === undefined || value === "" ? fallback : String(value);
const percent = value => value === null || value === undefined ? "--" : `${Math.round(Number(value) * 100)}%`;
const time = value => value ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(Number(value))) : "--";
const money = value => value === null || value === undefined ? "--" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(value));
const empty = label => `<div class="empty">${escapeHtml(label)}</div>`;
const splitValues = value => String(value || "").split(/[|,]/).map(item => item.trim()).filter(Boolean);
const lifecycleLabel = value => ({ candidate: "候选", probation: "观察", active: "活跃", elite: "精英", degraded: "降级", suspended: "淘汰" })[value] || value;
const reasonLabel = value => ({ leaderboard_24h: "24h Top100", leaderboard_30d: "30d Top100", market_cap_100k_3x: "10万市值 / 3倍", market_cap_100k_5x: "10万市值 / 5倍", market_cap_200k_3x: "20万市值 / 3倍", market_cap_200k_5x: "20万市值 / 5倍", market_cap_300k_5x: "30万市值 / 5倍", market_cap_500k_5x: "50万市值 / 5倍", market_cap_500k_10x: "50万市值 / 10倍", market_cap_1m_10x: "100万市值 / 10倍", market_cap_1m_20x: "100万市值 / 20倍", million_token_10x: "旧版百万市值 / 10倍", shared_holding: "共同持仓发现" })[value] || value;
const tagLabel = value => ({ "source.manual": "手动添加", "source.30d_top100": "30d Top100", "source.milestone_discovery": "高倍发现", "source.reverse_coholding": "共同持仓", "source.fomo_activity": "Fomo 动态", "ability.100k_3x": "10万 / 3倍", "ability.100k_5x": "10万 / 5倍", "ability.200k_3x": "20万 / 3倍", "ability.200k_5x": "20万 / 5倍", "ability.300k_5x": "30万 / 5倍", "ability.500k_5x": "50万 / 5倍", "ability.500k_10x": "50万 / 10倍", "ability.1m_10x": "100万 / 10倍", "ability.1m_20x": "100万 / 20倍", "style.early_launch": "新币早期", "style.old_token_momentum": "老币异动", "style.low_cap_high_multiple": "低市值高倍", "style.high_cap_large_position": "高市值重仓" })[value] || value;
const candidateStatusLabel = value => ({ current_admitted: "当前已准入", awaiting_second_early_token: "等待第二个早期代币", awaiting_recent_confirmation: "等待近期复现", no_evidence: "尚无高倍证据" })[value] || value;
const candidateReasonLabel = value => ({ strong_evidence_in_30d: "30天内命中一条强证据", two_early_tokens_in_30d: "30天内命中两个不同早期代币", only_one_early_token: "30天内仅有一个早期代币", evidence_outside_30d_window: "证据已超出30天窗口", candidate_evidence_missing: "尚未形成候选证据" })[value] || value;

const traderLabels = trader => {
  const typed = [...splitValues(trader.sourceTags), ...splitValues(trader.abilityTags), ...splitValues(trader.styleTags)];
  const labels = typed.map(value => ({ value, label: tagLabel(value) }));
  if (!typed.length && trader.manual) labels.push({ value: "source.manual", label: "手动添加" });
  if (!typed.length) splitValues(trader.leaderboardWindows).forEach(window => labels.push({ value: window === "30d" ? "source.30d_top100" : window, label: `${window} Top100` }));
  if (!typed.length) splitValues(trader.discoveryTypes).forEach(type => labels.push({ value: type, label: reasonLabel(type) }));
  if (labels.length === 0) labels.push({ value: trader.lifecycle, label: lifecycleLabel(trader.lifecycle) });
  return labels;
};

const addressCell = (addresses, family) => {
  const values = splitValues(addresses);
  if (!values.length) return '<span class="muted">待解析</span>';
  return values.map(address => `<button class="address-copy" type="button" data-copy="${escapeHtml(address)}" title="复制 ${family} 地址"><span>${escapeHtml(address.slice(0, 8))}…${escapeHtml(address.slice(-6))}</span><small>复制</small></button>`).join("");
};

const renderTraders = () => {
  const query = $("#trader-search").value.trim().toLowerCase();
  const lifecycle = $("#trader-lifecycle").value;
  const walletFilter = $("#trader-wallet-filter").value;
  const labelFilter = $("#trader-label-filter").value;
  const traders = state.traders.filter(trader => {
    const haystack = [trader.displayName, trader.handles, trader.solanaAddresses, trader.evmAddresses].join(" ").toLowerCase();
    const hasSolana = splitValues(trader.solanaAddresses).length > 0;
    const hasEvm = splitValues(trader.evmAddresses).length > 0;
    const walletMatch = !walletFilter || (walletFilter === "resolved" && (hasSolana || hasEvm)) || (walletFilter === "unresolved" && !hasSolana && !hasEvm) || (walletFilter === "solana" && hasSolana) || (walletFilter === "evm" && hasEvm);
    return (!query || haystack.includes(query)) && (!lifecycle || trader.lifecycle === lifecycle) && walletMatch && (!labelFilter || traderLabels(trader).some(label => label.value === labelFilter));
  });

  if (!traders.length) {
    $("#traders-grid").innerHTML = empty("没有符合当前筛选条件的交易员。");
    return;
  }

  $("#traders-grid").innerHTML = `<table class="operator-table"><thead><tr><th>交易员</th><th>Solana 地址</th><th>EVM 地址</th><th>标签</th><th>生命周期</th><th>质量 / 样本</th><th>更新时间</th></tr></thead><tbody>${traders.map(trader => `<tr data-entity="${escapeHtml(trader.entityId)}"><td><strong>${escapeHtml(text(trader.displayName, trader.handles ? `@${trader.handles}` : "未命名交易员"))}</strong><small>${trader.handles ? `@${escapeHtml(trader.handles)}` : escapeHtml(trader.entityId)}</small></td><td>${addressCell(trader.solanaAddresses, "Solana")}</td><td>${addressCell(trader.evmAddresses, "EVM")}</td><td><div class="tag-stack">${traderLabels(trader).map(label => `<span class="tag">${escapeHtml(label.label)}</span>`).join("")}</div></td><td><span class="tag ${escapeHtml(trader.lifecycle)}">${escapeHtml(lifecycleLabel(trader.lifecycle))}</span></td><td><strong>${percent(trader.quality)}</strong><small>${text(trader.sampleCount, 0)} 个样本</small></td><td>${time(trader.updatedAt)}</td></tr>`).join("")}</tbody></table>`;
};

const renderCandidates = () => {
  const query = $("#candidate-search").value.trim().toLowerCase();
  const source = $("#candidate-source").value;
  const chain = $("#candidate-chain").value;
  const identity = $("#candidate-identity").value;
  const candidates = state.candidates.filter(candidate => {
    const sources = [candidate.strongestEvidenceType].filter(Boolean);
    const chains = splitValues(candidate.chains).map(value => value.toLowerCase());
    const hasSolana = splitValues(candidate.solanaAddresses).length > 0;
    const hasEvm = splitValues(candidate.evmAddresses).length > 0;
    const identityMatch = !identity || candidate.identityState === identity || (identity === "solana" && hasSolana) || (identity === "evm" && hasEvm);
    const haystack = [candidate.displayName, candidate.handles, candidate.traderId, candidate.solanaAddresses, candidate.evmAddresses].join(" ").toLowerCase();
    return (!query || haystack.includes(query)) && (!source || sources.includes(source)) && (!chain || chains.includes(chain)) && identityMatch;
  });

  const funnel = state.candidateFunnel;
  $("#candidate-funnel").innerHTML = [
    ["历史1M代币", funnel.historicalTokenCount],
    ["已重建里程碑", funnel.milestoneReconstructedTokenCount],
    ["回补完成", funnel.backfillCompletedCount],
    ["回补等待", funnel.backfillPendingCount],
    ["高倍证据", funnel.evidenceCount],
    ["证据交易员", funnel.evidenceTraderCount],
    ["身份待解析", funnel.identityUnresolvedCount],
    ["历史能力", funnel.historicalOnlyCount],
    ["当前准入", funnel.currentAdmittedCount],
  ].map(([label, value]) => `<article><span>${escapeHtml(label)}</span><strong>${text(value, 0)}</strong></article>`).join("");

  const rows = candidates.length
    ? candidates.map(candidate => `<tr ${candidate.identityState === "resolved" ? `data-entity="${escapeHtml(candidate.traderId)}"` : ""}><td><strong>${escapeHtml(text(candidate.displayName, candidate.handles ? `@${candidate.handles}` : candidate.traderId))}</strong><small>${escapeHtml(candidate.traderId)}</small></td><td><span class="tag ${candidate.identityState === "resolved" ? "active" : "candidate"}">${candidate.identityState === "resolved" ? "已解析" : "待解析"}</span></td><td><div class="tag-stack"><span class="tag candidate">${escapeHtml(reasonLabel(candidate.strongestEvidenceType))}</span>${splitValues(candidate.chains).map(value => `<span class="tag chain">${escapeHtml(value)}</span>`).join("")}</div></td><td><strong>${text(candidate.earlyDistinctTokenCount, 0)}</strong></td><td><strong>${text(candidate.strongDistinctTokenCount, 0)}</strong></td><td><strong>${text(candidate.historicalDistinctTokenCount, 0)}</strong></td><td><span class="tag ${candidate.currentAdmission ? "active" : "candidate"}">${escapeHtml(candidateStatusLabel(candidate.status))}</span><small>${parseJsonList(JSON.stringify(candidate.reasonCodes || [])).map(candidateReasonLabel).map(escapeHtml).join("；")}</small></td><td><strong>${Number(candidate.strongestOpportunityMultiple ?? 0).toFixed(1)}x</strong><small>${time(candidate.latestEvidenceAt)}</small></td></tr>`).join("")
    : '<tr><td colspan="8">没有符合当前筛选条件的高倍候选交易员。</td></tr>';
  $("#candidates-grid").innerHTML = `<table class="operator-table"><thead><tr><th>Fomo 用户</th><th>Solana 地址 / EVM 地址</th><th>最强证据</th><th>独立代币</th><th>进度记录</th><th>历史代币</th><th>当前状态</th><th>最高倍数 / 发现时间</th></tr></thead><tbody>${rows}</tbody></table>`;
};

const cards = {
  backtests: items => items.length ? items.map(item => `<article class="record"><div><div class="tag-stack"><span class="tag">${escapeHtml(item.window)}</span><span class="tag">样本置信 ${percent(item.sampleConfidence)}</span><span class="tag">覆盖 ${percent(item.coverageConfidence)}</span></div><h3>${escapeHtml(item.entityId)}</h3><p>${escapeHtml(item.strategyVersion)} · 10x 命中 ${percent(item.hit10xRate)}</p></div><div class="score"><strong>${percent(item.adjustedQuality)}</strong><span>${text(item.validSamples, 0)} 个有效样本</span></div></article>`).join("") : empty("尚无足够交易样本形成滚动评分，因此暂时没有回测或淘汰记录。"),
  aggregations: items => items.length ? items.map(item => `<article class="record"><div><div class="tag-stack"><span class="tag chain">${escapeHtml(item.chain)}</span><span class="tag">${escapeHtml(({ observe: "正在聚合", broadcast: "首次信号合格", rebroadcast: "再次信号合格" })[item.action] || item.action)}</span><span class="tag">${escapeHtml(text(item.sourceState, "数据源待确认"))}</span></div><h3>${escapeHtml(item.tokenAddress)}</h3><p>${text(item.participantCount, 0)} 名交易员 · 累计买入 ${money(item.totalBuyUsd)} · ${Math.round(Number(item.windowMs ?? 0) / 60_000)} 分钟窗口</p><p>${item.broadcastCount} 次播报 · ${time(item.updatedAt)}</p><small>${item.missingConditionLabels?.length ? `仍缺少：${item.missingConditionLabels.map(escapeHtml).join("；")}` : "当前信号通道已满足"}</small></div><div class="score"><strong>${percent(item.currentScore)}</strong><span>${escapeHtml(text(item.lifecycleStage, "阶段待确认"))}</span></div></article>`).join("") : empty("尚未形成代币评估：当前还没有真实交易证据进入地址雷达。"),
  outcomes: items => items.length ? items.map(item => `<article class="record"><div><div class="tag-stack"><span class="tag">${escapeHtml(item.signalAction === "update" ? "再次播报" : "首次播报")}</span><span class="tag chain">${escapeHtml(text(item.opportunityType, "signal"))}</span></div><h3>${escapeHtml(item.tokenId)}</h3><p>${escapeHtml(item.signalId)}</p></div><div class="score"><strong>${percent(item.overallScore)}</strong><span>${time(item.publishedAt)}</span></div></article>`).join("") : empty("当前没有任何已经投递给用户的雷达信号。"),
  identityConflicts: items => items.length ? items.map(item => `<article class="record conflict"><div><span class="tag ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span><h3>@${escapeHtml(item.handle)}</h3><p>${escapeHtml(item.chainFamily)} · ${escapeHtml(item.address)}</p><p>当前归属：${escapeHtml(item.conflictingAccountId)}</p></div><div class="conflict-actions">${item.status === "pending" ? `<button data-conflict="${escapeHtml(item.conflictId)}" data-decision="accepted">接受</button><button data-conflict="${escapeHtml(item.conflictId)}" data-decision="rejected">拒绝</button>` : `<span>${escapeHtml(item.resolution || item.status)}</span>`}</div></article>`).join("") : empty("当前没有身份冲突。"),
};

const switchModule = module => {
  state.module = module;
  document.querySelectorAll("[data-module]").forEach(item => item.classList.toggle("active", item.dataset.module === module));
  document.querySelectorAll("[data-panel]").forEach(panel => panel.classList.toggle("active", panel.dataset.panel === module));
};

const parseJsonList = value => {
  try { const parsed = JSON.parse(value || "[]"); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
};

const parseJsonObject = value => {
  try { const parsed = JSON.parse(value || "{}"); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
};

const loadTraderDetail = async entityId => {
  switchModule("detail");
  $("#trader-detail").className = "detail-shell";
  $("#trader-detail").innerHTML = empty("正在读取交易员履历…");
  try {
    const detail = await api(`traders/${encodeURIComponent(entityId)}`);
    const latestAbility = detail.abilitySnapshots[0];
    const latestScore = latestAbility || detail.scores[0];
    const metrics = parseJsonObject(latestAbility?.metrics);
    const styles = parseJsonObject(latestAbility?.styles);
    $("#trader-detail").innerHTML = `
      <section class="profile-summary"><div><p class="eyebrow">TRADER ENTITY</p><h3>${detail.accounts.map(item => `@${escapeHtml(item.handle)}`).join(" · ") || escapeHtml(entityId)}</h3><div class="tag-stack"><span class="tag ${escapeHtml(detail.entity.lifecycle)}">${escapeHtml(lifecycleLabel(detail.entity.lifecycle))}</span>${detail.entity.manual ? '<span class="tag active">手动重点</span>' : ""}${detail.entity.locked ? '<span class="tag">锁定</span>' : ""}${Object.entries(styles).filter(([, score]) => Number(score) >= .6).map(([style]) => `<span class="tag">${escapeHtml(style)}</span>`).join("")}</div></div><div class="score"><strong>${percent(latestAbility?.adjustedQuality ?? latestScore?.quality)}</strong><span>${text(metrics.validSamples ?? latestScore?.sampleCount, 0)} 个有效样本</span></div></section>
      <div class="detail-grid">
        <section><h3>钱包身份</h3>${detail.wallets.length ? detail.wallets.map(wallet => `<div class="detail-row"><span>${escapeHtml(wallet.chainFamily)}</span><button class="address-copy" data-copy="${escapeHtml(wallet.address)}"><b>${escapeHtml(wallet.address)}</b><small>${escapeHtml(wallet.confidence)} · ${escapeHtml(wallet.source)}</small></button></div>`).join("") : empty("尚未回填 Solana 或 EVM 地址。")}</section>
        <section><h3>排行榜履历</h3>${detail.leaderboards.length ? detail.leaderboards.map(item => `<div class="detail-row"><span>${escapeHtml(item.window)} #${item.rank}</span><b>${money(item.profitUsd)}</b><small>${time(item.observedAt)}</small></div>`).join("") : empty("尚无 24h 或 30d Top100 记录。")}</section>
        <section><h3>发现来源</h3>${detail.discoveries.length ? detail.discoveries.map(item => `<div class="detail-row"><b>${escapeHtml(reasonLabel(item.discoveryType))}</b><small>${time(item.discoveredAt)}</small></div>`).join("") : empty("该交易员由常规采集进入，暂无额外候选发现记录。")}</section>
        <section><h3>生命周期记录</h3>${detail.lifecycleEvents.length ? detail.lifecycleEvents.map(item => `<div class="detail-row"><b>${escapeHtml(lifecycleLabel(item.previousState))} → ${escapeHtml(lifecycleLabel(item.nextState))}</b><small>${parseJsonList(item.reasons).map(reasonLabel).join(" · ") || item.strategyVersion} · ${time(item.occurredAt)}</small></div>`).join("") : empty("尚未发生升级、降级或淘汰。")}</section>
        <section><h3>可重复能力</h3>${latestAbility ? `<div class="ability-grid"><span>原始质量<b>${percent(latestAbility.rawQuality)}</b></span><span>调整质量<b>${percent(latestAbility.adjustedQuality)}</b></span><span>样本置信<b>${percent(latestAbility.sampleConfidence)}</b></span><span>结果覆盖<b>${percent(latestAbility.coverageConfidence)}</b></span><span>胜率<b>${percent(metrics.winRate)}</b></span><span>10x 命中<b>${percent(metrics.hit10xRate)}</b></span></div>` : empty("历史样本尚未达到能力评估条件。")}</section>
        <section><h3>高倍发现</h3><div class="ability-grid"><span>独立高倍案例<b>${text(metrics.independentHighMultipleCases, 0)}</b></span><span>单次依赖<b>${percent(metrics.singleWinDependency)}</b></span><span>近期有效<b>${percent(metrics.recentValidity)}</b></span><span>早期进入<b>${percent(metrics.earlyEntryRate)}</b></span></div></section>
      </div>
      <section class="history-section"><h3>代币级历史样本</h3>${detail.tokenSamples.length ? `<div class="table-shell"><table class="operator-table"><thead><tr><th>首次买入</th><th>链 / 代币</th><th>阶段</th><th>买入</th><th>入场市值</th><th>来源</th><th>样本状态</th></tr></thead><tbody>${detail.tokenSamples.map(sample => `<tr><td>${time(sample.firstBuyAt)}</td><td>${escapeHtml(sample.chain)}<small>${escapeHtml(sample.tokenAddress)}</small></td><td>${escapeHtml(sample.lifecycleStageAtEntry)}</td><td>${money(sample.totalBuyUsd)}</td><td>${money(sample.weightedEntryMarketCapUsd)}</td><td>${escapeHtml(sample.sourceState)}</td><td><span class="tag">${escapeHtml(sample.sampleStatus)}</span></td></tr>`).join("")}</tbody></table></div>` : empty("尚无可用于回测的代币级历史样本。")}</section>
      <section class="history-section"><h3>时间跨度结果</h3>${detail.tokenOutcomes.length ? `<div class="table-shell"><table class="operator-table"><thead><tr><th>样本</th><th>窗口</th><th>收盘倍数</th><th>最高 / 最低</th><th>捕获倍数</th><th>覆盖状态</th></tr></thead><tbody>${detail.tokenOutcomes.map(outcome => `<tr><td>${escapeHtml(outcome.sampleId)}</td><td>${escapeHtml(outcome.horizon)}</td><td>${text(outcome.closeMultiple)}x</td><td>${text(outcome.mfeMultiple)}x / ${text(outcome.maeMultiple)}x</td><td>${text(outcome.capturedMultiple)}x</td><td><span class="tag">${escapeHtml(outcome.coverageStatus)}</span></td></tr>`).join("")}</tbody></table></div>` : empty("结果窗口尚未成熟。")}</section>
      <section class="history-section"><h3>交易履历</h3>${detail.events.length ? `<div class="table-shell"><table class="operator-table"><thead><tr><th>时间</th><th>链</th><th>方向</th><th>代币</th><th>金额</th><th>当时市值</th><th>来源</th></tr></thead><tbody>${detail.events.map(event => `<tr><td>${time(event.occurredAt)}</td><td>${escapeHtml(event.chain)}</td><td><span class="tag ${escapeHtml(event.side)}">${escapeHtml(event.side)}</span></td><td>${escapeHtml(event.tokenAddress)}</td><td>${money(event.amountUsd)}</td><td>${money(event.marketCapUsd)}</td><td>${escapeHtml(event.source)}</td></tr>`).join("")}</tbody></table></div>` : empty("尚未采集到该交易员的真实交易事件；形成样本后会在这里显示完整履历。")}</section>`;
  } catch (error) {
    $("#trader-detail").innerHTML = empty(`读取交易员详情失败：${error.message}`);
  }
};

const renderIdentityQueue = () => {
  const query = $("#identity-search").value.trim().toLowerCase();
  const status = $("#identity-status").value;
  const items = state.identityQueue.filter(item => item.status !== "resolved" && (!query || item.handle.toLowerCase().includes(query)) && (!status || item.status === status));
  $("#identity-queue-list").innerHTML = items.length ? items.map(item => `<article class="identity-item"><div><div class="tag-stack"><span class="tag ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span>${item.reasons.map(reason => `<span class="tag">${escapeHtml(reasonLabel(reason))}</span>`).join("")}</div><h3>@${escapeHtml(item.handle)}</h3><p>优先级 ${item.priority} · 最近发现 ${time(item.lastSeenAt)}</p></div><button type="button" data-resolve-handle="${escapeHtml(item.handle)}">回填地址</button></article>`).join("") : empty("没有符合当前筛选条件的待解析用户名。");
};

const renderIdentityForms = () => {
  $("#identity-form-list").innerHTML = state.identityForms.length ? state.identityForms.map((item, index) => `<fieldset class="identity-form-row"><legend>用户 ${index + 1}</legend><label>Fomo 用户名<input data-identity-field="handle" data-index="${index}" value="${escapeHtml(item.handle)}" placeholder="handle"></label><label>EVM 地址<input data-identity-field="evmAddress" data-index="${index}" value="${escapeHtml(item.evmAddress)}" placeholder="0x..."></label><label>Solana 地址<input data-identity-field="solanaAddress" data-index="${index}" value="${escapeHtml(item.solanaAddress)}" placeholder="Solana address"></label><button type="button" class="remove-form" data-remove-identity="${index}">移除</button></fieldset>`).join("") : empty("从左侧选择待解析用户名，或新增一个空白表单。");
};

const addIdentityForm = handle => {
  if (handle && state.identityForms.some(item => item.handle === handle)) return;
  state.identityForms.push({ handle: handle || "", evmAddress: "", solanaAddress: "" });
  renderIdentityForms();
};

const loadIdentity = async () => {
  const [queue, conflicts, registry] = await Promise.all([api("identity-queue"), api("identity-conflicts"), api("monitoring-registry")]);
  state.identityQueue = queue;
  renderIdentityQueue();
  $("#identity-conflicts-grid").innerHTML = cards.identityConflicts(conflicts);
  const registryState = registry.syncPending ? `注册表 v${registry.version}，采集器仍在应用 v${registry.appliedVersion || 0}` : `注册表 v${registry.version || 0} 已由采集器接管`;
  $("#identity-summary").textContent = `${queue.filter(item => item.status !== "resolved").length} 个待解析 · ${conflicts.filter(item => item.status === "pending").length} 个冲突 · ${registry.walletCount} 个监控钱包（EVM ${registry.evmWalletCount} / Solana ${registry.solanaWalletCount}）· ${registryState}`;
};

const renderAggregations = () => {
  const minimum = Math.max(0, Number($("#aggregation-minimum").value) || 0);
  const chain = $("#aggregation-chain").value;
  const lifecycle = $("#aggregation-lifecycle").value;
  const status = $("#aggregation-status").value;
  localStorage.setItem("addressRadarMinimumAggregationUsd", String(minimum));
  const items = state.aggregations.filter(item => Number(item.totalBuyUsd ?? 0) >= minimum && (!chain || item.chain === chain) && (!lifecycle || item.lifecycleStage === lifecycle) && (!status || item.action === status));
  $("#aggregations-grid").innerHTML = cards.aggregations(items);
  $("#aggregation-filter-summary").textContent = `显示 ${items.length}/${state.aggregations.length} 个，低于 ${money(minimum)} 已隐藏`;
};

const renderSignals = () => {
  const query = $("#signal-search").value.trim().toLowerCase();
  const action = $("#signal-action").value;
  const chain = $("#signal-chain").value;
  const items = state.signals.filter(item => (!query || `${item.tokenId} ${item.signalId}`.toLowerCase().includes(query)) && (!action || item.signalAction === action) && (!chain || String(item.tokenId || "").split(":")[0] === chain));
  $("#outcomes-grid").innerHTML = cards.outcomes(items);
};

const renderWalletAnalyses = () => {
  const statusLabel = value => ({ queued: "等待采集", collecting: "采集中", normalizing: "整理交易", pricing: "补充价格", evaluating: "计算能力", completed: "分析完成", retrying: "等待重试", partial: "部分完成", blocked: "任务已阻塞", review_required: "等待审核", accepted: "已收录", rejected: "已拒绝", insufficient_data: "数据不足", failed: "采集失败", cancelled: "已取消" })[value] || value;
  const rows = state.walletAnalyses;
  $("#wallet-analysis-grid").innerHTML = rows.length ? `<table class="operator-table"><thead><tr><th>地址</th><th>状态</th><th>覆盖</th><th>胜率</th><th>峰值倍数</th><th>高倍命中</th><th>更新时间</th><th>操作</th></tr></thead><tbody>${rows.map(item => {
    const metrics = parseJsonObject(item.metrics);
    const phase = item.phase || item.status;
    return `<tr><td><strong>${escapeHtml(item.displayName || item.fomoHandle || item.chainFamily)}</strong><small>${escapeHtml(item.address)}</small></td><td><span class="tag ${escapeHtml(phase)}">${escapeHtml(statusLabel(phase))}</span><small>${Number(item.progressPercent ?? 0).toFixed(0)}% · 心跳 ${time(item.heartbeatAt)}</small>${item.lastError ? `<small>${escapeHtml(item.lastError)}</small>` : ""}</td><td><strong>${percent(item.coverageRate)}</strong><small>${text(item.discoveredTokens ?? item.validSampleCount, 0)}/${text(item.requestedSampleCount, 100)} 个样本</small></td><td><strong>${percent(metrics.profitableRate)}</strong></td><td><strong>${metrics.medianPeakMultiple == null ? "--" : `${Number(metrics.medianPeakMultiple).toFixed(2)}x`}</strong><small>均值 ${metrics.meanPeakMultiple == null ? "--" : `${Number(metrics.meanPeakMultiple).toFixed(2)}x`}</small></td><td><strong>5x ${percent(metrics.hit5xRate)}</strong><small>10x ${percent(metrics.hit10xRate)}</small></td><td>${time(item.updatedAt)}</td><td>${item.status === "review_required" ? `<button type="button" data-admit-analysis="${escapeHtml(item.analysisId)}">转入身份解析</button><button type="button" data-analysis-decision="reject" data-analysis-id="${escapeHtml(item.analysisId)}">拒绝</button><button type="button" data-analysis-decision="insufficient" data-analysis-id="${escapeHtml(item.analysisId)}">数据不足</button>` : '<span class="muted">--</span>'}</td></tr>`;
  }).join("")}</tbody></table>` : empty("还没有地址分析任务。");
};

const historicalStatusLabel = value => ({ complete: "已重建", missing: "缺失", not_scheduled: "未安排", pending: "等待回补", running: "正在回补", completed: "回补完成", failed: "回补失败" })[value] || value;

const renderMilestones = () => {
  const query = $("#milestone-search").value.trim().toLowerCase();
  const chain = $("#historical-chain").value;
  const date = $("#historical-date").value;
  const milestone = $("#historical-milestone").value;
  const backfill = $("#historical-backfill").value;
  const buyers = $("#historical-buyers").value;
  const evidence = $("#historical-evidence").value;
  const items = state.historicalTokens.filter(item => {
    const reachedDate = item.firstReached1mAt ? new Date(Number(item.firstReached1mAt)).toISOString().slice(0, 10) : "";
    const buyerMatch = !buyers || (buyers === "yes" ? Number(item.eligibleBuyerCount) > 0 : Number(item.eligibleBuyerCount) === 0);
    const evidenceMatch = !evidence || (evidence === "yes" ? Number(item.evidenceTraderCount) > 0 : Number(item.evidenceTraderCount) === 0);
    return (!query || `${item.symbol || ""} ${item.tokenAddress}`.toLowerCase().includes(query)) && (!chain || item.chain === chain) && (!date || reachedDate === date) && (!milestone || item.milestoneStatus === milestone) && (!backfill || item.backfillStatus === backfill) && buyerMatch && evidenceMatch;
  });
  const operations = state.historicalOperations;
  $("#historical-operations").innerHTML = [
    ["历史代币", state.historicalTokens.length],
    ["Dune 今日额度", text(operations.creditsUsedToday, 0)],
    ["等待分区", text(operations.pendingPartitionCount, 0)],
    ["运行分区", text(operations.runningPartitionCount, 0)],
    ["失败分区", text(operations.failedPartitionCount, 0)],
    ["历史水位", time(operations.historicalWatermark)],
    ["实时水位", time(operations.realtimeWatermark)],
  ].map(([label, value]) => `<article><span>${escapeHtml(label)}</span><strong>${text(value, 0)}</strong></article>`).join("");
  $("#historical-filter-summary").textContent = `显示 ${items.length}/${state.historicalTokens.length} 个历史代币；每个合约仅占一行。`;
  const tokenRows = items.length ? items.map(item => `<tr><td><div class="token-identity">${item.imageUrl ? `<img src="${escapeHtml(item.imageUrl)}" alt="" loading="lazy">` : `<span class="token-fallback">${escapeHtml((item.symbol || "?").slice(0, 1))}</span>`}<div><strong>${escapeHtml(text(item.symbol, "未知代币"))}</strong><span class="tag chain">${escapeHtml(item.chain)}</span><button class="address-copy compact-copy" type="button" data-copy="${escapeHtml(item.tokenAddress)}"><span>${escapeHtml(item.tokenAddress.slice(0, 8))}…${escapeHtml(item.tokenAddress.slice(-6))}</span><small>复制 CA</small></button></div></div></td><td>${time(item.firstReached1mAt)}</td><td><strong>${money(item.peakMarketCapUsd)}</strong></td><td><span class="tag ${escapeHtml(item.milestoneStatus)}">${escapeHtml(historicalStatusLabel(item.milestoneStatus))}</span></td><td><span class="tag ${escapeHtml(item.backfillStatus)}">${escapeHtml(historicalStatusLabel(item.backfillStatus))}</span></td><td><strong>${text(item.eligibleBuyerCount, 0)}</strong></td><td><strong>${text(item.evidenceTraderCount, 0)}</strong></td><td>${item.diagnostics?.length ? item.diagnostics.map(value => `<small>${escapeHtml(value)}</small>`).join("") : '<span class="tag completed">证据链完整</span>'}</td><td><button type="button" data-re-evaluate-token="${escapeHtml(item.tokenId)}" ${["pending", "running"].includes(item.reEvaluationStatus) ? "disabled" : ""}>${["pending", "running"].includes(item.reEvaluationStatus) ? "重评等待中" : "重新评估"}</button></td></tr>`).join("") : '<tr><td colspan="9" class="empty-row">没有符合当前筛选条件的历史代币。</td></tr>';
  $("#milestone-grid").innerHTML = `<table class="operator-table historical-token-table"><thead><tr><th>代币</th><th>首次达到 1M</th><th>历史最高市值</th><th>里程碑</th><th>历史回补</th><th>早期买家</th><th>证据交易员</th><th>诊断</th><th>操作</th></tr></thead><tbody>${tokenRows}</tbody></table>`;
  const partitions = state.historicalPartitions;
  $("#historical-partitions-grid").innerHTML = partitions.length ? `<table class="operator-table"><thead><tr><th>分区</th><th>链 / 查询</th><th>日期范围</th><th>状态</th><th>行数 / 游标</th><th>水位线</th><th>诊断</th><th>操作</th></tr></thead><tbody>${partitions.map(item => `<tr><td><strong>${escapeHtml(item.partitionId)}</strong><small>${text(item.tokenAddresses?.length, 0)} 个代币</small></td><td>${escapeHtml(item.chain)}<small>${escapeHtml(item.queryKind)}</small></td><td>${time(item.dayStart)}<small>至 ${time(item.dayEnd)}</small></td><td><span class="tag ${escapeHtml(item.status)}">${escapeHtml(historicalStatusLabel(item.status))}</span><small>尝试 ${text(item.attemptCount, 0)} 次</small></td><td>${text(item.rowCount, 0)}<small>游标 ${text(item.nextOffset, 0)}</small></td><td>${time(item.watermark)}</td><td><small>${escapeHtml(text(item.lastError, "运行正常"))}</small></td><td>${item.status === "failed" ? `<button type="button" data-retry-partition="${escapeHtml(item.partitionId)}">重试分区</button>` : '<span class="muted">--</span>'}</td></tr>`).join("")}</tbody></table>` : empty("暂无历史分区。");
};

const load = async () => {
  const [overview, chainPage, aggregationPage, candidateFunnel, candidatePage, historicalTokenPage, historicalPartitionPage, historicalOperations] = await Promise.all([apiV2("workbench/summary"), apiV2("chains"), apiV2("token-aggregates"), apiV2("candidate-funnel"), apiV2("candidates"), apiV2("historical-tokens"), apiV2("historical-partitions"), apiV2("historical-operations")]);
  const metrics = { traders: overview.addressLibraryCount, candidates: candidateFunnel.currentAdmittedCount, aggregations: overview.aggregatedTokenCount, broadcasts: overview.deliveredSignalCount };
  for (const [key, value] of Object.entries(metrics)) { const node = $(`#metric-${key}`); if (node) node.textContent = text(value, "0"); }
  for (const selector of ["#aggregation-chain", "#signal-chain", "#historical-chain"]) $(selector).insertAdjacentHTML("beforeend", chainPage.items.map(chain => `<option value="${escapeHtml(chain.id)}">${escapeHtml(chain.labelZh)}</option>`).join(""));
  const modules = ["traders", "candidates", "backtests", "aggregations", "outcomes", "wallet-analyses"];
  const data = await Promise.all(modules.map(module => api(module)));
  state.traders = data[0];
  renderTraders();
  state.candidateFunnel = candidateFunnel;
  state.candidates = candidatePage.items;
  renderCandidates();
  $("#backtests-grid").innerHTML = cards.backtests(data[2]);
  state.aggregations = aggregationPage.items;
  state.signals = data[4];
  state.historicalTokens = historicalTokenPage.items;
  state.historicalPartitions = historicalPartitionPage.items;
  state.historicalOperations = historicalOperations;
  state.walletAnalyses = data[5];
  $("#aggregation-minimum").value = localStorage.getItem("addressRadarMinimumAggregationUsd") || "100";
  renderAggregations();
  renderSignals();
  renderMilestones();
  renderWalletAnalyses();
  await loadIdentity();
  $("#connection-label").textContent = "实时账本已连接";
};
document.querySelectorAll("[data-module]").forEach(button => button.addEventListener("click", () => switchModule(button.dataset.module)));
["#trader-search", "#trader-lifecycle", "#trader-wallet-filter", "#trader-label-filter"].forEach(selector => $(selector).addEventListener("input", renderTraders));
["#candidate-search", "#candidate-source", "#candidate-chain", "#candidate-identity"].forEach(selector => $(selector).addEventListener("input", renderCandidates));
["#identity-search", "#identity-status"].forEach(selector => $(selector).addEventListener("input", renderIdentityQueue));
["#aggregation-minimum", "#aggregation-chain", "#aggregation-lifecycle", "#aggregation-status"].forEach(selector => $(selector).addEventListener("input", renderAggregations));
$("#signal-search").addEventListener("input", renderSignals);
$("#signal-chain").addEventListener("input", renderSignals);
$("#signal-action").addEventListener("input", renderSignals);
["#milestone-search", "#historical-chain", "#historical-date", "#historical-milestone", "#historical-backfill", "#historical-buyers", "#historical-evidence"].forEach(selector => $(selector).addEventListener("input", renderMilestones));

$("#traders-grid").addEventListener("click", event => {
  const copy = event.target.closest("[data-copy]");
  if (copy) { event.stopPropagation(); void navigator.clipboard.writeText(copy.dataset.copy); copy.querySelector("small").textContent = "已复制"; return; }
  const row = event.target.closest("[data-entity]");
  if (row) void loadTraderDetail(row.dataset.entity);
});

$("#candidates-grid").addEventListener("click", event => {
  const copy = event.target.closest("[data-copy]");
  if (copy) { event.stopPropagation(); void navigator.clipboard.writeText(copy.dataset.copy); copy.querySelector("small").textContent = "已复制"; return; }
  const row = event.target.closest("[data-entity]");
  if (row) void loadTraderDetail(row.dataset.entity);
});

$("#trader-detail").addEventListener("click", event => {
  const copy = event.target.closest("[data-copy]");
  if (copy) void navigator.clipboard.writeText(copy.dataset.copy);
});

$("#identity-queue-list").addEventListener("click", event => {
  const button = event.target.closest("[data-resolve-handle]");
  if (button) addIdentityForm(button.dataset.resolveHandle);
});

$("#add-identity-form").addEventListener("click", () => addIdentityForm(""));
$("#identity-form-list").addEventListener("input", event => {
  const input = event.target.closest("[data-identity-field]");
  if (input) state.identityForms[Number(input.dataset.index)][input.dataset.identityField] = input.value;
});
$("#identity-form-list").addEventListener("click", event => {
  const button = event.target.closest("[data-remove-identity]");
  if (!button) return;
  state.identityForms.splice(Number(button.dataset.removeIdentity), 1);
  renderIdentityForms();
});

$("#identity-import-form").addEventListener("submit", async event => {
  event.preventDefault();
  const feedback = $("#identity-feedback");
  const items = state.identityForms.map(item => ({ handle: item.handle.trim().replace(/^@/, ""), evmAddress: item.evmAddress.trim(), solanaAddress: item.solanaAddress.trim() })).filter(item => item.handle && (item.evmAddress || item.solanaAddress));
  if (!items.length) { feedback.textContent = "请至少填写一个用户名和一个钱包地址。"; return; }
  let result;
  try {
    result = await api("identity-imports/direct", { method: "POST", body: JSON.stringify({ items }) });
  } catch (error) {
    feedback.textContent = `回填失败：${error.message}`;
    return;
  }
  feedback.textContent = `回填完成：${result.resolved} 个已解析，${result.conflicts} 个冲突。`;
  const submitted = new Set(items.map(item => item.handle.toLowerCase()));
  state.identityForms = state.identityForms.filter(item => !submitted.has(item.handle.trim().replace(/^@/, "").toLowerCase()));
  renderIdentityForms();
  try {
    await Promise.all([loadIdentity(), api("traders").then(traders => { state.traders = traders; renderTraders(); })]);
  } catch (error) {
    feedback.textContent = `回填已保存，但列表刷新失败：${error.message}`;
  }
});

$("#manual-trader-form").addEventListener("submit", async event => {
  event.preventDefault();
  const feedback = $("#manual-trader-feedback");
  const abilityTag = $("#manual-ability-tag").value;
  const styleTag = $("#manual-style-tag").value;
  const body = {
    displayName: $("#manual-display-name").value.trim(),
    fomoHandle: $("#manual-fomo-handle").value.trim(),
    evmAddresses: [$("#manual-evm-address").value.trim()].filter(Boolean),
    solanaAddresses: [$("#manual-solana-address").value.trim()].filter(Boolean),
    sourceTags: ["source.manual"],
    abilityTags: abilityTag ? [abilityTag] : [],
    styleTags: styleTag ? [styleTag] : [],
    priority: $("#manual-priority").value,
    notes: $("#manual-notes").value.trim(),
  };
  try {
    const result = await api("traders/manual", { method: "POST", body: JSON.stringify(body) });
    if (state.selectedWalletAnalysisId) {
      await api(`wallet-analyses/${encodeURIComponent(state.selectedWalletAnalysisId)}/accept`, { method: "POST", body: JSON.stringify({ entityId: result.entityId }) });
      state.selectedWalletAnalysisId = null;
      state.walletAnalyses = await api("wallet-analyses");
      renderWalletAnalyses();
    }
    feedback.textContent = `已加入观察地址库：${result.displayName}`;
    event.currentTarget.reset();
    state.traders = await api("traders");
    renderTraders();
  } catch (error) {
    feedback.textContent = `新增失败：${error.message}`;
  }
});

$("#wallet-analysis-form").addEventListener("submit", async event => {
  event.preventDefault();
  const feedback = $("#wallet-analysis-feedback");
  try {
    const result = await api("wallet-analyses", { method: "POST", body: JSON.stringify({
      chainFamily: $("#wallet-analysis-chain").value,
      address: $("#wallet-analysis-address").value.trim(),
      displayName: $("#wallet-analysis-name").value.trim(),
      fomoHandle: $("#wallet-analysis-handle").value.trim(),
    requestedSampleCount: Number($("#wallet-analysis-limit").value) || 300,
    }) });
    feedback.textContent = `分析任务已建立：${result.status}`;
    state.walletAnalyses = await api("wallet-analyses");
    renderWalletAnalyses();
  } catch (error) {
    feedback.textContent = `创建失败：${error.message}`;
  }
});

$("#wallet-analysis-grid").addEventListener("click", async event => {
  const decision = event.target.closest("[data-analysis-decision]");
  if (decision) {
    await api(`wallet-analyses/${encodeURIComponent(decision.dataset.analysisId)}/${decision.dataset.analysisDecision}`, { method: "POST", body: "{}" });
    state.walletAnalyses = await api("wallet-analyses");
    renderWalletAnalyses();
    return;
  }
  const button = event.target.closest("[data-admit-analysis]");
  if (!button) return;
  const item = state.walletAnalyses.find(candidate => candidate.analysisId === button.dataset.admitAnalysis);
  if (!item) return;
  state.selectedWalletAnalysisId = item.analysisId;
  switchModule("identity");
  $("#manual-display-name").value = item.displayName || item.fomoHandle || "手动分析钱包";
  $("#manual-fomo-handle").value = item.fomoHandle || "";
  $("#manual-evm-address").value = item.chainFamily === "evm" ? item.address : "";
  $("#manual-solana-address").value = item.chainFamily === "solana" ? item.address : "";
  $("#manual-trader-feedback").textContent = "已带入分析结果，请设置标签后确认加入地址库。";
});

$("#identity-conflicts-grid").addEventListener("click", async event => {
  const button = event.target.closest("[data-conflict]");
  if (!button) return;
  await api(`identity-conflicts/${encodeURIComponent(button.dataset.conflict)}`, { method: "PUT", body: JSON.stringify({ decision: button.dataset.decision }) });
  await loadIdentity();
});

$("#milestone-grid").addEventListener("click", async event => {
  const copy = event.target.closest("[data-copy]");
  if (copy) { await navigator.clipboard.writeText(copy.dataset.copy); copy.querySelector("small").textContent = "已复制"; return; }
  const button = event.target.closest("[data-re-evaluate-token]");
  if (!button) return;
  button.disabled = true;
  await apiV2(`historical-tokens/${encodeURIComponent(button.dataset.reEvaluateToken)}/re-evaluate`, { method: "POST", body: "{}" });
  const page = await apiV2("historical-tokens");
  state.historicalTokens = page.items;
  renderMilestones();
});

$("#historical-partitions-grid").addEventListener("click", async event => {
  const button = event.target.closest("[data-retry-partition]");
  if (!button) return;
  button.disabled = true;
  await apiV2(`historical-partitions/${encodeURIComponent(button.dataset.retryPartition)}/retry`, { method: "POST", body: "{}" });
  const [partitionPage, operations] = await Promise.all([apiV2("historical-partitions"), apiV2("historical-operations")]);
  state.historicalPartitions = partitionPage.items;
  state.historicalOperations = operations;
  renderMilestones();
});

void load();
