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

  it("runs the Fomo verification bridge through an explicit shell", async () => {
    const content = await readFile(
      resolve("deployment/systemd/address-radar-fomo-verification-sync.service"),
      "utf8",
    );
    expect(content).toContain(
      "ExecStart=/bin/sh /opt/address-radar/current/scripts/sync-fomo-verification.sh",
    );
  });

  it("bounds backup resource usage and publishes completed snapshots atomically", async () => {
    const content = await readFile(resolve("scripts/backup-production-state.sh"), "utf8");
    const unit = await readFile(resolve("deployment/systemd/address-radar-backup.service"), "utf8");
    expect(content).toContain("ADDRESS_RADAR_BACKUP_PAGES_PER_STEP");
    expect(content).toContain("ADDRESS_RADAR_BACKUP_SLEEP_MS");
    expect(content).toContain("ADDRESS_RADAR_BACKUP_TIMEOUT_SECONDS");
    expect(content).toContain("ionice -c2 -n7 nice -n 15 timeout");
    expect(content).toContain("address-radar.db.partial");
    expect(unit).toContain("ExecStartPre=+/usr/bin/systemctl stop address-radar-scanner.service address-radar-wallet-monitor.service address-radar-wallet-analysis.service");
    expect(unit).toContain("ExecStopPost=+/usr/bin/systemctl start address-radar-scanner.service address-radar-wallet-monitor.service address-radar-wallet-analysis.service");
  });
});
