export function createTraceResponseFence() {
  let revision = 0;
  return { capture:()=>revision, invalidate:()=>++revision, isCurrent:value=>value===revision };
}

export function summarizeTracePurchase(row,asOf) {
  const valid = row.revisionState === "original" && !row.pendingRevision &&
    typeof row.executionEvidenceRef === "string" && row.executionEvidenceRef.length > 0 &&
    typeof row.ownershipEvidenceRef === "string" && row.ownershipEvidenceRef.length > 0 &&
    typeof row.entryPriceUsd === "string" && Number(row.entryPriceUsd) > 0 && Number.isFinite(Number(row.entryPriceUsd));
  let opportunity = "等待机会评估";
  const evaluation = row.opportunity;
  if (!valid) opportunity = "待补成交依据";
  else if (evaluation && !evaluation.currentExecution) opportunity = "旧评估待重算";
  else if (evaluation?.status === "hit" && [3,5].includes(evaluation.tier)) opportunity = `已发现 ${evaluation.tier}x 机会`;
  else if (evaluation?.status === "awaiting_verification") opportunity = "价格依据待核验";
  else if (evaluation?.status === "insufficient_coverage") opportunity = "缺价格覆盖，不计失败";
  else if (evaluation?.status === "excluded") opportunity = "样本已排除";
  else if (evaluation?.status === "observing") opportunity = asOf > row.expiresAt ? "观察期结束，覆盖待核验" : "30 天观察中";
  return {amountLabel:`${row.amountUsd ?? "待补"} USD${row.amountEstimated ? "（名义估算）" : ""}`,
    entryLabel:valid ? `真实成交入场价 ${row.entryPriceUsd}` : "待补成交依据",opportunityLabel:opportunity};
}

export function summarizeTraceSignal(signal) {
  if (signal.intentStatus === "cancelled" || signal.readinessStatus === "cancelled") return "已取消，未播报";
  if (signal.readinessStatus === "validated") return "发送前校验已通过，仍未播报";
  if (signal.readinessStatus === "deferred") return "依据待补 / 校验延期，未播报";
  return "待发送且待重新校验，未播报";
}

if (typeof document !== "undefined") {
  const byId = id=>document.getElementById(id);
  const fence = createTraceResponseFence();
  let token = "", nextCursor = null, controller = null;
  const clear = () => {
    fence.invalidate(); controller?.abort(); nextCursor=null;
    byId("purchases").replaceChildren(); byId("next-page").disabled=true;
    byId("capability").textContent="需要读取最新快照"; byId("identity").textContent="需要读取最新快照";
    byId("signals").textContent="需要读取最新快照"; byId("page-count").textContent="当前页：0 条";
  };
  byId("entity-id").addEventListener("input",clear);
  byId("operator-token").addEventListener("input",clear);
  const read = async cursor => {
    controller?.abort(); controller=new AbortController();
    const stamp=fence.capture(), entityId=byId("entity-id").value.trim();
    if (!token || !entityId) { byId("feedback").textContent="请填写操作员令牌和实体 ID。"; return; }
    const query=new URLSearchParams({entityId});
    if (cursor) { query.set("afterBoughtAt",String(cursor.boughtAt)); query.set("afterSampleId",cursor.sampleId); }
    byId("feedback").textContent="正在读取同一数据库快照……";
    try {
      const response=await fetch(`/api/v2/forward-trace?${query}`,{headers:{Authorization:`Bearer ${token}`},signal:controller.signal,cache:"no-store"});
      if (!response.ok) throw new Error(`读取失败（HTTP ${response.status}），未修改数据。`);
      const snapshot=await response.json();
      if (!fence.isCurrent(stamp)) return;
      if (snapshot.entityId!==entityId || snapshot.gatewayDeliveryEnabled!==false) throw new Error("快照对象或投递状态不符合只读验收约束。");
      byId("purchases").replaceChildren();
      for (const row of snapshot.purchases) {
        const view=summarizeTracePurchase(row,snapshot.asOf), tr=document.createElement("tr");
        for (const value of [`${row.chain} / ${row.tokenAddress}\n${row.sampleId}`,view.amountLabel,view.entryLabel,view.opportunityLabel,
          JSON.stringify({execution:row.executionEvidenceRef,ownership:row.ownershipEvidenceRef,evaluation:row.opportunity?.evaluationId ?? null})]) {
          const td=document.createElement("td"); td.textContent=value; tr.append(td);
        }
        byId("purchases").append(tr);
      }
      const cap=snapshot.capability;
      byId("capability").textContent=cap ? `${cap.stableCapability ? "达到持续发现能力标准" : "仍在积累机会证据"}\n不同代币 3x：${cap.hit3xTokens}；5x：${cap.hit5xTokens}\n评估时间：${new Date(cap.evaluatedAt).toISOString()}\n版本：${cap.versionId}\n这是已持久化评估，不代替当前身份和信号校验。` : "尚无能力评估；不视为失败，也不等于已准入。";
      byId("identity").textContent=snapshot.identityChecks.length ? JSON.stringify(snapshot.identityChecks,null,2) : "尚无身份校验回执；监控与雷达资格需要分别验证。";
      byId("signals").textContent=snapshot.signals.length ? snapshot.signals.map(s=>`${summarizeTraceSignal(s)}\n${JSON.stringify(s,null,2)}`).join("\n\n") : "尚无属于该实体的信号回执；不能认定整个流程已完成。";
      nextCursor=snapshot.nextCursor; byId("next-page").disabled=!nextCursor;
      byId("page-count").textContent=`当前页：${snapshot.purchases.length} 条`;
      byId("snapshot-clock").textContent=`快照：${new Date(snapshot.asOf).toISOString()} · 当前页非总覆盖量 · 实时来源覆盖未验收${snapshot.signalPageLimited || snapshot.identityPageLimited ? " · 身份 / 信号历史展示已截断" : ""}`;
      byId("feedback").textContent="只读快照已加载。待发送不是已播报，缺数据不是失败。";
    } catch (error) {
      if (fence.isCurrent(stamp) && error.name !== "AbortError") byId("feedback").textContent=error.message;
    }
  };
  byId("trace-form").addEventListener("submit",event=>{
    event.preventDefault();
    const entered=byId("operator-token").value;
    if (entered) token=entered;
    byId("operator-token").value=""; clear(); void read(null);
  });
  byId("first-page").addEventListener("click",()=>{clear();void read(null);});
  byId("next-page").addEventListener("click",()=>{const cursor=nextCursor;clear();void read(cursor);});
  window.addEventListener("pagehide",()=>{token="";clear();});
}
