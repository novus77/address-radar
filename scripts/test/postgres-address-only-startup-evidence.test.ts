import { expect, test } from "vitest";
import { validateAddressOnlyStartupEvidence } from "../postgres-address-only-startup-evidence.js";
import type { AddressOnlyStartupManifest } from "../../apps/automation/src/postgres-address-only-startup.js";
const manifest = { operationId: "op", importId: "import", generationId: "gen", releaseSha256: "a".repeat(64),
  backupSha256: "b".repeat(64), fenceSha256: "c".repeat(64), activatedAt: 1 } as AddressOnlyStartupManifest;
const receipt = () => ({ protocol: "address-only-native-startup-evidence-v1", operationId: "op", importId: "import", generationId: "gen",
  releaseSha256: manifest.releaseSha256, backupSha256: manifest.backupSha256, fenceSha256: manifest.fenceSha256,
  deploymentSha256: "d".repeat(64), safetyEnvironmentSha256: "e".repeat(64), measuredAt: 1,
  sourceEpoch: [{path:"/var/lib/address-radar/address-radar.db",device:"1",inode:"2",size:"100",uid:"0",gid:"0",mode:"256",mtimeNs:"1",ctimeNs:"1"}],
  sourceSealed: true, importCommitted: true, gatewayDeliveryEnabled: false, fomoEnabled: false, fullHistoricalMiningEnabled: false });
test("accepts an independently pinned native measurement without granting delivery", () => {
  const measured = validateAddressOnlyStartupEvidence(receipt(), manifest);
  expect(Object.isFrozen(measured)).toBe(true); expect(measured.gatewayDeliveryEnabled).toBe(false);
});
test.each(["operationId", "importId", "generationId", "releaseSha256", "backupSha256", "fenceSha256"])("rejects changed %s", key => {
  expect(() => validateAddressOnlyStartupEvidence({ ...receipt(), [key]: "other" }, manifest)).toThrow("BINDING");
});
test.each(["sourceSealed", "importCommitted"])("rejects missing native %s", key => {
  expect(() => validateAddressOnlyStartupEvidence({ ...receipt(), [key]: false }, manifest)).toThrow("BINDING");
});
test.each(["gatewayDeliveryEnabled", "fomoEnabled", "fullHistoricalMiningEnabled"])("rejects enabled %s", key => {
  expect(() => validateAddressOnlyStartupEvidence({ ...receipt(), [key]: true }, manifest)).toThrow("BINDING");
});
test("rejects unknown fields and accessors without evaluating them", () => {
  expect(() => validateAddressOnlyStartupEvidence({ ...receipt(), trusted: true }, manifest)).toThrow("FIELDS");
  const value = receipt(); Object.defineProperty(value,"backupSha256",{get() { throw new Error("getter invoked"); },enumerable:true});
  expect(() => validateAddressOnlyStartupEvidence(value,manifest)).toThrow("FIELDS");
});

test("binds the actual safety environment without treating absent flags as false", async () => {
  const { addressOnlySafetyEnvironmentDigest } = await import("../postgres-address-only-startup-evidence.js");
  const names = ["ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED", "ADDRESS_RADAR_FOMO_BROWSER_ENABLED",
    "ADDRESS_RADAR_FOMO_CAPTURE_ENABLED", "ADDRESS_RADAR_FULL_HISTORICAL_MINING_ENABLED"];
  const env = Object.fromEntries(names.map(name=>[name,"false"]));
  expect(addressOnlySafetyEnvironmentDigest(env)).toMatch(/^[a-f0-9]{64}$/);
  for(const name of names) {
    expect(()=>addressOnlySafetyEnvironmentDigest({...env,[name]:"true"})).toThrow("ACTUAL_SAFETY");
    const missing={...env}; delete missing[name];
    expect(()=>addressOnlySafetyEnvironmentDigest(missing)).toThrow("ACTUAL_SAFETY");
  }
});
test("rejects unsafe or unmeasured source epochs", () => {
  for(const epoch of [[],[{...receipt().sourceEpoch[0],uid:"997"}],[{...receipt().sourceEpoch[0],mode:"420"}],
    [{...receipt().sourceEpoch[0],path:"/tmp/source.db"}]]) {
    expect(()=>validateAddressOnlyStartupEvidence({...receipt(),sourceEpoch:epoch},manifest)).toThrow("EPOCH");
  }
  expect(()=>validateAddressOnlyStartupEvidence({...receipt(),measuredAt:Date.now()+100000},manifest)).toThrow("EPOCH");
});
