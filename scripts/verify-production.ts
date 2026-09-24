const baseUrl = process.argv[2] ?? "http://127.0.0.1:3214";
const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5_000) });
if (!response.ok) throw new Error(`Health check failed with HTTP ${response.status}`);
const health = await response.json() as { status?: unknown };
if (health.status !== "ok") throw new Error("Health response is not ok");
console.log(JSON.stringify({ verified: true, baseUrl, health }));
