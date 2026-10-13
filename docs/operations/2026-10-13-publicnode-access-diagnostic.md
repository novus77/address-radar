# PublicNode Access Diagnostic

## Confirmed observation

One bounded read-only JSON-RPC request was sent from production host 152.32.185.240 to https://solana-rpc.publicnode.com using the default Python urllib client and getGenesisHash. The response was HTTP 403, Server cloudflare, Content-Type text/plain; charset=UTF-8, and body `error code: 1010`.

- Started at: 1791877948861 ms since Unix epoch.
- Completed at: 1791877948917 ms since Unix epoch.
- Cloudflare Ray ID: a49cc3dcbb47cf4c-HKG.
- Response body bytes: 17.
- Response SHA256: 2938e9f1284180959e33ab1718d0793a72ff6e4cdb8108c34dcd14e69446de5c.
- Audit path: /var/lib/address-radar-maintenance-tools/source-access-diagnostic-1791877948917/access-diagnostic.json.
- Audit SHA256: dd11cf926abfa870231e5db756b2b8c1256295cf3dcd62010aa46578030ccd40.

The preceding official replay control at https://api.mainnet-beta.solana.com returned HTTP 200 with a JSON-RPC result. This excludes a general inability to reach all RPC endpoints in that observed environment, not every possible network issue.

## Interpretation and limits

Cloudflare documents error 1010 as denial based on the client/browser signature. This is not error 1015, the documented rate-limit error. No HTTP 429 or Retry-After was observed, and these results do not establish quota exhaustion, an IP-wide ban, or a regional ban.

The failed request used Python urllib. Production Node execution-client access has not been established by this check. Do not generalize the result into a claim that every client or the upstream Solana node is unavailable. The response was an edge-layer refusal, not a usable JSON-RPC response or a successful source review.

Official reference: https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/

## Provider support request

Please investigate Ray ID a49cc3dcbb47cf4c-HKG at the timestamp above and confirm the supported access method for a server-side JSON-RPC client from host 152.32.185.240. Our approved internal cap remains 60 requests per 60 seconds with maximum concurrency 1; diagnostics used bounded individual read-only requests. We are not requesting a quota increase, a change of operator, or a bypass of Cloudflare protections. Please advise whether this client requires explicit permission, registration, or a provider-side rule correction.

No message has been sent to the provider as part of this task. The host address is supplied as operational context; its actual egress address has not been independently measured.

## Preparation gate

Retain the current source/operator pairing and budget. Do not spoof a browser, rotate proxies/accounts, use challenge-solving workarounds, or silently make the official replay both primary and replay. Await provider clarification or permission before further access attempts that would change client identity to avoid the refusal.

No successful new provider review, final approval evidence, replacement hash, source switch, service restart, database write, or signal delivery occurred. Existing expired review evidence remains unusable for fresh import. Engineering tests remain valid engineering evidence, not proof of live source acceptance.
