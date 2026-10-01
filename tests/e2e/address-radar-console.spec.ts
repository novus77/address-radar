import { expect, test } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAddressConsoleApplication } from "../../apps/console/src/application.js";
import { startAddressRadarConsole, type AddressRadarConsoleServer } from "../../apps/console/src/server.js";
import { openAddressRadarRepository } from "../../packages/database/src/index.js";

let server: AddressRadarConsoleServer;

test.beforeAll(async () => {
  const directory = await mkdtemp(join(tmpdir(), "address-console-e2e-"));
  const databasePath = join(directory, "address.sqlite");
  const repository = openAddressRadarRepository(databasePath);
  repository.upsertFomoAccount({ accountId: "candidate-account", handle: "Multiplier", firstSeenAt: 1, lastSeenAt: 2 });
  repository.upsertTraderEntity({ entityId: "candidate-entity", lifecycle: "candidate", manual: false, locked: false, createdAt: 1, updatedAt: 2 });
  repository.linkAccountToEntity({ entityId: "candidate-entity", accountId: "candidate-account", confidence: "high", source: "fomo_stream", observedAt: 2 });
  repository.saveCandidateDiscovery({ discoveryId: "candidate-discovery", accountId: "candidate-account", discoveryType: "market_cap_500k_10x", payload: JSON.stringify({ chain: "solana", tokenAddress: "TokenA", maximumOpportunity: 12.5, tierRank: 7 }), discoveredAt: 2 });
  repository.close();
  server = await startAddressRadarConsole({
    application: createAddressConsoleApplication(databasePath),
    host: "127.0.0.1",
    port: 0,
  });
});

test.afterAll(async () => {
  await server.close();
});

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`renders all eight address intelligence modules on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(server.url);
    await expect(page.getByText("账本已连接")).toBeVisible();

    for (const label of ["地址库", "候选队列", "30天能力回测", "代币聚合", "信号结果", "历史覆盖与重评估", "身份解析", "地址分析"]) {
      await page.getByRole("button", { name: label }).click();
      await expect(page.locator("section.module.active").getByRole("heading", { name: label })).toBeVisible();
    }
    await page.getByRole("button", { name: "候选队列" }).click();
    await expect(page.getByPlaceholder("搜索候选用户名或地址")).toBeVisible();
    await expect(page.getByLabel("候选来源")).toBeVisible();
    await expect(page.getByLabel("候选链")).toBeVisible();
    await expect(page.getByLabel("候选链").locator('option[value="robinhood"]')).toHaveText("Robinhood");
    await expect(page.getByLabel("身份状态")).toBeVisible();
    for (const heading of ["Fomo 用户", "Solana 地址", "EVM 地址", "最强证据", "独立代币", "进度记录", "最高倍数", "发现时间"]) {
      await expect(page.locator('section[data-panel="candidates"]')).toContainText(heading);
    }
    await page.getByRole("button", { name: "历史覆盖与重评估" }).click();
    for (const label of ["历史链", "里程碑状态", "回补状态", "早期买家", "候选证据"]) {
      await expect(page.getByLabel(label)).toBeVisible();
    }
    for (const heading of ["代币", "首次达到 1M", "历史最高市值", "里程碑", "历史回补", "早期买家", "证据交易员", "诊断", "操作"]) {
      await expect(page.locator('section[data-panel="milestones"]')).toContainText(heading);
    }
    await expect(page.locator("#historical-operations")).toContainText("Dune 今日额度");
    await expect(page.locator("#historical-partitions-grid")).toContainText("暂无历史分区");
    await expect(page.locator('section[data-panel="detail"] h2')).toHaveText("交易员详情");
  });
}
