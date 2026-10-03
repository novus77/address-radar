const targetPath = "/api/v2/forward-targets";
const inputText = value => {
  if (typeof value !== "string" || !value.trim() || value.length > 512) throw new Error("invalid_target_control_input");
  return value.trim();
};
const targetKey = input => {
  if (input.channel !== "fomo" && input.channel !== "wallet") throw new Error("invalid_target_channel");
  if (input.channel === "fomo" ? input.walletFamily !== null : !["evm", "solana"].includes(input.walletFamily)) throw new Error("invalid_target_family");
  return { entityId: inputText(input.entityId), channel: input.channel, subjectId: inputText(input.subjectId), walletFamily: input.walletFamily };
};
export function createForwardTargetOperatorClient(options) {
  let token = "";
  const pending = new Map();
  const identifier = options.id || (() => globalThis.crypto.randomUUID());
  const request = async (path, body) => {
    if (!token) throw new Error("operator_token_required");
    let response;
    try {
      response = await options.fetch(`${targetPath}${path}`, {
        method: body === undefined ? "GET" : "POST", credentials: "omit", cache: "no-store",
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000),
      });
    } catch { throw new Error("request_outcome_unknown"); }
    let result;
    try { result = await response.json(); } catch { throw new Error("request_outcome_unknown"); }
    if (!response.ok) {
      const code = typeof result?.error === "string" && /^[a-z0-9_]{1,80}$/.test(result.error) ? result.error : "target_control_request_failed";
      throw new Error(code);
    }
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("request_outcome_unknown");
    return result;
  };
  return Object.freeze({
    setToken(value) { const next = typeof value === "string" ? value.trim() : ""; if (next !== token) pending.clear(); token = next; },
    state(input) {
      const key = targetKey(input), query = new URLSearchParams({ entityId: key.entityId, channel: key.channel, subjectId: key.subjectId });
      if (key.walletFamily !== null) query.set("walletFamily", key.walletFamily);
      return request(`/state?${query}`);
    },
    hydrate(input) { return request("/hydrate", targetKey(input)); },
    registry(channel, after = null) {
      if (channel !== "fomo" && channel !== "wallet") throw new Error("invalid_target_channel");
      const query = new URLSearchParams({ channel, limit: "100" });
      if (after !== null) { query.set("afterEntityId", inputText(after.entityId)); query.set("afterSubjectKey", inputText(after.subjectKey)); }
      return request(`/registry?${query}`);
    },
    async authorize(input) {
      const entityId = inputText(input.entityId), basisRef = inputText(input.basisRef), action = input.action;
      if (action !== "grant" && action !== "revoke") throw new Error("invalid_manual_authorization_action");
      const commandKey = JSON.stringify([entityId, action, basisRef]);
      if (!pending.has(commandKey)) pending.set(commandKey, inputText(identifier()));
      const result = await request("/manual-authorization", { authorizationId: pending.get(commandKey), entityId, action, basisRef });
      pending.delete(commandKey);
      return result;
    },
  });
}

export function createOperatorRequestFence() {
  let revision = 0;
  return Object.freeze({ capture: () => revision, invalidate: () => { revision += 1; }, isCurrent: captured => captured === revision });
}

function mountOperatorInterface(document) {
  const client = createForwardTargetOperatorClient({ fetch: globalThis.fetch.bind(globalThis) });
  const session = document.getElementById("operator-session"), selection = document.getElementById("target-selection");
  const authorization = document.getElementById("target-authorization"), registry = document.getElementById("target-registry");
  const status = document.getElementById("operator-status"), decision = document.getElementById("target-decision");
  const grant = document.getElementById("grant-target"), revoke = document.getElementById("revoke-target"), next = document.getElementById("registry-next");
  let connected = false, busy = false, currentState = null, cursor = null, registryChannel = null;
  const targetFence = createOperatorRequestFence(), registryFence = createOperatorRequestFence();
  const field = (form, name) => form.elements.namedItem(name);
  const selectedKey = () => targetKey({ entityId: field(selection, "entityId").value, channel: field(selection, "channel").value,
    subjectId: field(selection, "subjectId").value, walletFamily: field(selection, "channel").value === "fomo" ? null : field(selection, "walletFamily").value });
  const message = (text, error = false) => { status.textContent = text; status.dataset.error = String(error); };
  const controls = () => {
    for (const button of document.querySelectorAll("[data-session]")) button.disabled = !connected || busy;
    grant.disabled = !connected || busy || currentState?.monitoringEligible !== true;
    revoke.disabled = !connected || busy || currentState?.status !== "evaluated";
    next.disabled = !connected || busy || cursor === null || registryChannel !== field(registry, "channel").value;
    for (const button of session.querySelectorAll("button")) button.disabled = busy;
  };
  const renderState = state => {
    currentState = state;
    decision.replaceChildren();
    const list = document.createElement("dl");
    for (const [label, value] of [
      ["登记状态", state.status || "未知"], ["监控资格", state.monitoringEligible === true ? "允许监控" : "等待校验 / 未启用"],
      ["雷达资格", state.radarEligible === true ? "可参与，仍须满足其他信号条件" : "当前不可参与"],
      ["授权依据", state.authorizationBasis || "请结合人工审计与能力证据核对"],
      ["身份版本", state.targetVersionId || "未登记"], ["人工授权版本", state.manualAuthorizationId || "无"],
      ["能力版本", state.capabilityVersionId || "无当前版本"],
    ]) {
      const title = document.createElement("dt"), content = document.createElement("dd");
      title.textContent = label; content.textContent = String(value); list.append(title, content);
    }
    decision.append(list); controls();
  };
  const invalidate = () => { targetFence.invalidate(); currentState = null; decision.textContent = "目标发生变化，请重新读取状态。"; controls(); };
  const invalidateRegistry = () => {
    registryFence.invalidate(); cursor = null; registryChannel = null;
    document.getElementById("registry-results").replaceChildren();
    document.getElementById("registry-summary").textContent = "会话或筛选已变化，请重新读取目录。"; controls();
  };
  const errors = {
    forward_target_controls_disabled: "控制功能未启用。需要完成业务启用审批，不会自动重试。",
    verified_identity_source_not_found: "既有库中没有该目标的可校验关联，未登记。",
    target_control_forbidden: "当前操作者没有该操作权限。", unauthorized: "凭据无效，请重新设置。",
    request_outcome_unknown: "请求结果不确定。先核对状态；保持目标、动作和依据不变重试会复用命令 ID。",
    manual_authorization_id_conflict: "命令 ID 与既有审计记录冲突，未覆盖记录。",
  };
  const execute = async operation => {
    if (busy) return;
    busy = true; controls();
    try { await operation(); } catch (error) { message(errors[error.message] || `操作未确认：${error.message}`, true); }
    finally { busy = false; controls(); }
  };
  session.addEventListener("submit", event => {
    event.preventDefault(); const token = document.getElementById("operator-token");
    client.setToken(token.value); connected = Boolean(token.value.trim()); token.value = "";
    document.getElementById("session-state").textContent = connected ? "凭据已保存在当前页面内存，尚未验证权限。" : "未设置凭据";
    invalidate(); invalidateRegistry(); controls();
  });
  document.getElementById("disconnect-session").addEventListener("click", () => {
    client.setToken(""); connected = false; invalidate(); invalidateRegistry();
    document.getElementById("registry-results").replaceChildren(); document.getElementById("session-state").textContent = "会话已清除";
    message("凭据已清除；未修改服务器数据。"); controls();
  });
  selection.addEventListener("input", invalidate);
  selection.addEventListener("change", () => { field(selection, "walletFamily").disabled = field(selection, "channel").value === "fomo"; invalidate(); });
  selection.addEventListener("submit", event => {
    event.preventDefault(); const action = event.submitter?.value || "read";
    execute(async () => {
      const key = selectedKey(), revision = targetFence.capture();
      if (action === "hydrate" && !globalThis.confirm("确认从既有库校验并登记该目标？不会合并身份、关注账号或发送信号。")) return;
      const result = action === "hydrate" ? await client.hydrate(key) : await client.state(key);
      if (!targetFence.isCurrent(revision)) {
        message(action === "hydrate" ? `先前目标 ${key.entityId} 的登记请求已确认；新目标状态未更新。` : "目标已切换，旧读取结果已丢弃。请读取新目标状态。"); return;
      }
      renderState(result.state || {}); message(action === "hydrate" ? "登记请求已确认，资格以当前服务器判定为准。" : "已读取最近登记快照，不代表实时来源覆盖。");
    });
  });
  authorization.addEventListener("submit", event => {
    event.preventDefault(); const action = event.submitter?.value;
    execute(async () => {
      const key = selectedKey(), basisRef = inputText(field(authorization, "basisRef").value), revision = targetFence.capture();
      if (action !== "grant" && action !== "revoke") return;
      if (action === "grant" && currentState?.monitoringEligible !== true) throw new Error("target_not_verified");
      if (!globalThis.confirm(action === "grant" ? "明确授权该目标参与雷达？不等于稳定能力认证，不会立即投递信号。" : "撤销人工雷达授权？不会删除审计记录或停止监控，系统能力资格仍单独判定。")) return;
      await client.authorize({ entityId: key.entityId, action, basisRef });
      if (!targetFence.isCurrent(revision)) { message(`先前目标 ${key.entityId} 的授权操作已确认；新目标状态未更新。`); return; }
      message("授权操作已确认。正在读取最新资格。");
      try {
        const latest = await client.state(key);
        if (!targetFence.isCurrent(revision)) { message(`先前目标 ${key.entityId} 的授权操作已确认，过期状态已丢弃。`); return; }
        renderState(latest.state || {}); message("授权操作已确认并刷新资格，其他信号条件仍须满足。");
      } catch {
        if (targetFence.isCurrent(revision)) invalidate();
        message(`目标 ${key.entityId} 的授权操作已确认，但状态刷新失败。请单独读取状态，不要重复创建授权。`, true);
      }
    });
  });
  const loadRegistry = async after => {
    const channel = field(registry, "channel").value, revision = registryFence.capture(), result = await client.registry(channel, after);
    if (!registryFence.isCurrent(revision)) { message("目录筛选或会话已变化，旧目录响应已丢弃。"); return; }
    if (!Array.isArray(result.monitored) || !Number.isSafeInteger(result.scanned)) throw new Error("invalid_registry_response");
    registryChannel = channel; cursor = result.nextCursor || null;
    const results = document.getElementById("registry-results"); results.replaceChildren();
    for (const target of result.monitored) {
      const button = document.createElement("button"); button.type = "button";
      button.textContent = `${target.entityId} / ${target.channel} / ${target.subjectId}`;
      button.addEventListener("click", () => {
        if (busy) return;
        field(selection, "entityId").value = target.entityId; field(selection, "channel").value = target.channel;
        field(selection, "subjectId").value = target.subjectId; field(selection, "walletFamily").value = target.walletFamily || "solana";
        field(selection, "walletFamily").disabled = target.channel === "fomo"; invalidate();
        message("已选择目标，尚未读取或修改资格。");
      }); results.append(button);
    }
    document.getElementById("registry-summary").textContent = `本页扫描 ${result.scanned} 条，已验证监控 ${result.monitored.length} 条。${cursor ? "还有后续页。" : "本次分页读取已结束。"} 不代表实时数据源覆盖。`;
    message("已读取目录，未修改目标。");
  };
  registry.addEventListener("change", invalidateRegistry);
  registry.addEventListener("submit", event => { event.preventDefault(); execute(() => loadRegistry(null)); });
  next.addEventListener("click", () => execute(() => loadRegistry(cursor)));
  controls();
}
if (typeof document !== "undefined" && document.getElementById("operator-session")) mountOperatorInterface(document);
