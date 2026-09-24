import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const units = ["scanner", "wallet-monitor", "wallet-analysis", "console", "backup"] as const;

describe("standalone systemd units", () => {
  it.each(units)("isolates the %s service", async name => {
    const content = await readFile(resolve(`deployment/systemd/address-radar-${name}.service`), "utf8");
    expect(content).toContain("/opt/address-radar/current");
    expect(content).toContain("/var/lib/address-radar");
    expect(content).toContain("/var/log/address-radar");
    expect(content).toContain("/etc/address-radar/address-radar.env");
    expect(content).not.toContain("/opt/fomo-radar");
    expect(content).not.toContain("/var/lib/fomo-address-radar");
  });

  it("keeps the environment template on standalone paths", async () => {
    const content = await readFile(resolve("deployment/address-radar.env.example"), "utf8");
    expect(content).toContain("/var/lib/address-radar/address-radar.db");
    expect(content).not.toContain("/opt/fomo-radar");
    expect(content).not.toContain("/var/lib/fomo-address-radar");
  });
});
