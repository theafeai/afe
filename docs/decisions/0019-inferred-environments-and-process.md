# ADR 0019: Inferred environments and delivery process

- Status: Accepted
- Date: 2026-11-24
- Related: [ADR 0017](0017-spectrum-design-language.md) rule 9 (how environments look)
- Reference: [Environment mapping](../environment-mapping.md), "Built-in rules" and
  "Inferred setup"

## Context

Organisations ship in very different ways: previews on every pull request or on
demand, production that deploys automatically or waits for an approval, every commit
to every environment or batches of commits, any number of environments with any names.
Earlier versions of Afe seeded four default environments (production, staging,
preview, development) and folded each org's names into them with built-in rules. That
imposed one process on everyone and lost information: `uat` became "staging", and two
different production targets became one "Production".

## Decision

1. **Afe adapts to each org's process and never imposes one.** No screen, data model
   or default assumes fixed environments, a fixed stage order, one commit per
   deployment, a particular approval flow or a particular cadence.
2. **No environment is seeded.** A new tenant starts with no environments. Its
   environments are inferred from the names its tools report, plus any its admin
   creates. The built-in name rules still exist but are off by default for new
   tenants; an admin can switch any of them on.
3. **Afe infers, the admin adjusts, and inference never overwrites the admin.** The
   `setup.infer` job infers, per environment, its name, order, whether it is
   production-like, how changes reach it (gating), whether changes ship one by one or
   in batches, its cadence and the tool values that place events in it. Every fact has
   a confidence (`certain`, `strong`, `probable`, `weak`), a one-line reason and
   evidence (tool and environment names, counts and rule names only). An admin can
   confirm, rename, reorder or override any field, or say a name is not an
   environment.
4. **Two stores, never mixed.** Inferred facts live in `inferred_setup`, written only
   by the inference job; admin choices live in `setup_overrides`, written only by
   admin API calls. A statement-level trigger refuses writes unless the transaction
   declared the matching writer, so the separation is structural. Reads merge them:
   admin override, else the admin's environment row, else inference. When inference
   disagrees with an admin choice, Afe reports it ("Afe noticed") and does not change
   the choice; an admin who keeps their value records the inferred value they kept it
   against, so the same disagreement is not reported again.
5. **Production-like instead of fixed kinds.** Environments are the org's own. The only
   classification Afe applies is a `productionLike` flag, which gives the environment
   the solid chip (ADR 0017 rule 9). Afe never derives a kind from a name. The legacy
   `kind` field stays in the API for compatibility only: `production` for
   production-like environments, `preview` for a family of short-lived environments,
   `other` for everything else.
6. **Deterministic rules first; any LLM help is opt-in.** Inference uses deterministic
   rules over observed events: the same events always give the same facts, in every
   edition, and no data leaves the deployment. This repository contains no LLM
   integration. Any future LLM assistance (for example suggesting names or explaining
   an unusual setup) must be an explicit opt-in, decided separately, including what
   data it may send.

## Consequences

- Migration `0042` adds the two stores and `mapping_settings.builtin_rules_default`.
  It is forward-only and changes nothing stored: tenants that had changed their
  mapping keep their environment rows (now admin environments) and keep the built-in
  rules on, so what they see does not change. Tenants that never changed their mapping
  used four virtual defaults that were never stored; after the upgrade their
  environments are inferred, until the first inference run they are unmapped, and an
  admin who wants the old buckets can create them and switch the built-in rules on.
- All setup data is per tenant (`tenant_id` in both stores and every query).
  `set_by` is the acting principal's id, never a request field.
- Evidence never contains repository names, logins or commit messages, so the setup
  can be shown to users who cannot see every repository.
- Order inference is relative and is not yet compared with admin choices for "Afe
  noticed"; production-like, gating and batching are.
