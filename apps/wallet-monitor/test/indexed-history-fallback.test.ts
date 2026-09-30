import { describe, expect, it } from "vitest";
import { createIndexedHistoryFetch } from "../src/indexed-history-fallback.js";
describe("indexed history capability fallback", () => {
  it("preserves pagination and cools down unsupported routes", async () => {
    const urls: string[] = [];
    const fetch = createIndexedHistoryFetch({ now: () => 1000, fallbackEndpoint: "https://backup.test", fetch: async url => {
      urls.push(String(url)); return new Response("", { status: String(url).includes("primary.test") ? 404 : 200 });
    } });
    for (let i = 0; i < 2; i++) expect((await fetch("https://primary.test/api/v2/addresses/wallet/token-transfers?index=7")).status).toBe(200);
    expect(urls).toEqual(["https://primary.test/api/v2/addresses/wallet/token-transfers?index=7", "https://backup.test/api/v2/addresses/wallet/token-transfers?index=7", "https://backup.test/api/v2/addresses/wallet/token-transfers?index=7"]);
  });
  it("keeps unsupported history blocked without fabricating a fallback", async () => {
    let calls = 0;
    const fetch = createIndexedHistoryFetch({ now: () => 1000, fetch: async () => { calls++; return new Response(null, { status: 404 }); } });
    expect((await fetch("https://missing.test/history")).status).toBe(404);
    expect((await fetch("https://missing.test/history")).status).toBe(404);
    expect(calls).toBe(1);
  });
});
