# ResonantOS Disciplines

This folder holds repository-local operating disciplines for ResonantOS.

Local disciplines are the first landing place for recurring project practices
that affect this repository's pull requests, release surface, validation, or
contributor workflow. Promote a practice to Arcanum only after the local rule is
clear, useful, and broadly reusable beyond ResonantOS.

## Catalog

Start with [DISCIPLINES.md](DISCIPLINES.md). Each row points to a discipline
card under [cards/](cards/).

## Local-First Rule

When a run discovers a new discipline from ResonantOS evidence:

1. Add or update the local ResonantOS discipline first.
2. Validate the local catalog.
3. Apply the rule to active ResonantOS pull requests.
4. Promote a generalized Arcanum discipline only when the practice is
   product-neutral and useful outside this repository.

## Validation

Run:

```bash
npm run discipline:validate
```

For pull request staging, also run:

```bash
npm run browser-first:audit-scope:staged
```
