# Address Radar

Address Radar is a server-side address intelligence workspace for scanning,
monitoring, and analyzing blockchain addresses.

## Scope

This repository owns server-side address intelligence components and their
shared contracts. It intentionally excludes the browser extension, licensing
systems, and customer Gateway ownership.

## Repository boundaries

Run `pnpm check:boundaries` to verify that this standalone service does not
reintroduce browser extension, licensing, customer Gateway, or legacy runtime
dependencies. The same rule is covered by the architecture test suite.
