import { describe, expect, it } from "vitest";
import { createPostgresCaptureRepository, type PostgresCaptureEnvelope } from "../src/postgres-capture-inbox.js";

const envelope: PostgresCaptureEnvelope = { sourceNamespace: "fomo-live", sourceEventId: "event-1", collectorId: "server",
  sessionId: "session-1", receivedAt: 1_000, scrubbedPayload: "{}", semanticPayload: null };
function fixture() {
  let calls = 0;
  const repository = createPostgresCaptureRepository({ async query() { calls += 1; throw new Error("unexpected SQL"); } }, { maximumPayloadBytes: 128 });
  return { repository, calls: () => calls };
}

describe("PostgreSQL capture input bounds", () => {
  it("rejects oversized payloads before accessing storage", async () => {
    const f = fixture();
    await expect(f.repository.append({ ...envelope, scrubbedPayload: "x".repeat(129) })).rejects.toThrow("configured limit");
    expect(f.calls()).toBe(0);
  });
  it("rejects missing stable source identity before accessing storage", async () => {
    const f = fixture();
    await expect(f.repository.append({ ...envelope, sourceEventId: " " })).rejects.toThrow("identity");
    expect(f.calls()).toBe(0);
  });
  it("does not silently round unsafe source integers", async () => {
    const f = fixture();
    await expect(f.repository.append({ ...envelope, semanticPayload: '{"amount":9007199254740993}' })).rejects.toThrow("lossless string");
    expect(f.calls()).toBe(0);
  });
});
