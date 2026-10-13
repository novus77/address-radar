"use strict";
const labels = { capture: "原始交易采集", normalization: "交易标准化", consumer_work: "消费任务", token_discovery: "代币发现", milestone_confirmation: "里程碑确认", purchase: "合格买入样本", opportunity: "当前机会评估", opportunity_work: "机会任务", ability_evaluation: "当前能力评估", ability_work: "能力任务", signal_projection: "信号投影", signal_readiness: "待验证雷达" };
const element = id => document.getElementById(id);
const count = value => typeof value === "string" && /^\d+$/.test(value) ? BigInt(value).toLocaleString("zh-CN") : "未核实";
async function request(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000), cache: "no-store" });
  if (!response.ok) throw new Error("read_unavailable");
  return response.json();
}
async function refresh() {
  try {
    const snapshot = await request("/api/v2/operations/closed-loop");
    if (snapshot.backend !== "postgresql" || snapshot.gatewayDeliveryEnabled !== false || snapshot.coverageVerified !== false
      || snapshot.runnableDelta15m !== null || !Number.isSafeInteger(snapshot.asOf) || snapshot.asOf < 0
      || typeof snapshot.generationId !== "string" || !Array.isArray(snapshot.stages)) throw new Error("invalid_boundary");
    element("connection").textContent = "PostgreSQL 只读";
    element("generation").textContent = String(snapshot.generationId);
    element("sampled").textContent = "快照时间：" + new Date(snapshot.asOf).toLocaleString("zh-CN");
    const rows = [];
    for (const stage of snapshot.stages) {
      const row = document.createElement("tr");
      for (const text of [labels[stage.stage] || "未识别阶段", typeof stage.status === "string" ? stage.status : "未核实",
        count(stage.count), count(stage.newRecords1h), Number.isSafeInteger(stage.lastProgressAt) ? new Date(stage.lastProgressAt).toLocaleString("zh-CN") : "未核实",
        typeof stage.reasonCode === "string" ? stage.reasonCode : "未提供"]) {
        const cell = document.createElement("td"); cell.textContent = text; row.append(cell);
      }
      rows.push(row);
    }
    element("stages").replaceChildren(...rows);
  } catch { element("connection").textContent = "读取失败，保留上次快照"; }
}
element("trace-form").addEventListener("submit", async event => {
  event.preventDefault(); const entity = element("entity").value.trim();
  if (!entity) return;
  element("trace-status").textContent = "正在核对已提交证据…";
  try {
    const trace = await request("/api/v2/operations/forward-trace?entityId=" + encodeURIComponent(entity));
    element("trace-output").textContent = JSON.stringify(trace, null, 2);
    element("trace-output").hidden = false;
    element("trace-status").textContent = "仅为本页证据；没有数据不代表已经通过覆盖验收。";
  } catch { element("trace-status").textContent = "证据读取失败，请稍后重试。"; }
});
void refresh(); setInterval(() => { if (!document.hidden) void refresh(); }, 15000);
