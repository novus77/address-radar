# Production Source Execution Assembly Plan

> Use executing-plans and independent review for implementation.

Goal: close the missing production job assembly port without minting approval or
borrowing isolated identities. The assembler is preparation-only: it validates
already reviewed final metadata and pins, and exclusively writes one execution
job plus a preparation receipt. Existing execution remains the only activation
port. No database, RPC, systemctl, credentials rotation or source renewal occurs.

Files: create `scripts/assemble-production-source-execution.py` and
`scripts/test/assemble-production-source-execution.test.py`. Preserve the executor
contract and update the current SPAC with verified status only.

1. Add a pure validation/assembly function with an injected pinned reader for
   tests. Production CLI supplies only the built-in protected file reader.
2. Enforce exact production schema, target, operation, approval, deadline and
   import/probe/transition bindings. Reject isolated inputs, stale deadlines,
   release mismatch, unsafe flags and non-production targets.
3. Verify root-protected source files and staged sealed release inventory. Bound
   individual reads and total input size; never print private input or exceptions.
4. Write new preparation output exclusively under the maintenance root. Never
   overwrite a prior attempt. Report PREPARED_NOT_EXECUTED only.
5. Run refusal/success regressions and independent review. Only then collect real
   current metadata for a final production job; missing final metadata is a gate,
   not permission to rewrite hashes or approve sources.

Acceptance: correct production materials produce an executor-compatible job;
invalid materials fail before any output. Preparation must not perform activation
or imply source/payload validity beyond structural binding. Final metadata rebinding
and genuine executor preflight remain separate requirements.
