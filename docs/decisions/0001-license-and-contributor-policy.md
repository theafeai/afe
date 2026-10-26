# ADR 0001: License and contributor policy

- Status: Accepted
- Date: 2026-10-26
- Issue: AFE-1

## Context

Afe is an open-core project. The public `afe` repository contains the full
self-hostable product. A hosted, multi-tenant service and paid features
(see ADR 0002) live in a separate private repository that depends on this one.

We need a license that:

- lets companies adopt and self-host Afe without legal review friction,
- lets us build a commercial layer on top of the open core,
- keeps outside contributions easy and keeps future relicensing possible.

## Options considered

| Option           | Adoption                                      | Protection from free hosting | Contributor friction                                 |
| ---------------- | --------------------------------------------- | ---------------------------- | ---------------------------------------------------- |
| Apache-2.0 + DCO | High; most enterprise policies pre-approve it | None                         | Low (sign-off line)                                  |
| Apache-2.0 + CLA | High                                          | None                         | Medium (CLA bot, legal review for some contributors) |
| AGPL-3.0 + CLA   | Lower; many enterprises ban AGPL              | Strong                       | Medium                                               |

## Decision

- **License: Apache License 2.0** for all code in this repository.
- **Contributor policy: Developer Certificate of Origin (DCO 1.1).** Every commit
  must carry a `Signed-off-by:` trailer (`git commit -s`). CI enforces this on
  pull requests.

## Reasoning

- An audit tool is adopted by platform and security teams; AGPL is frequently
  blocked by their legal policies, which would undercut the self-host path.
- The value of the hosted service is operations, multi-tenancy, retention and
  compliance features, which live in the private repo; we do not need copyleft
  to protect it.
- Apache-2.0 includes an explicit patent grant, which matters to enterprises.
- Under Apache-2.0, inbound = outbound licensing plus a DCO gives us the right to
  distribute contributions, including inside the commercial product, without a
  CLA. DCO is the lightest policy that still records provenance of every line.

## Consequences

- Anyone may host Afe commercially. We accept this.
- Contributions are licensed under Apache-2.0 by the contributor (Section 5 of
  the license); the DCO sign-off certifies they have the right to do so.
- If we ever need to relicense, we would need consent from contributors or to
  rewrite their contributions. We accept this trade-off for lower friction.
