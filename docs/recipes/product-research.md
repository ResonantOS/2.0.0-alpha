# Recipe: Product research

Product-research example from the Augmentor Future List. Compares candidate
products across tabs, saves a multi-tab research trail to Living Archive, and
drafts decision notes the human reviews before any purchase or add-to-cart
on a shared account.

## Goal

Open several candidate product pages in tabs, capture specifications,
pricing, warranty, and independent review summaries, save a multi-tab
research trail to Living Archive intake, and produce a side-by-side decision
note the human can act on.

Goals and prompts describe intended workflows, not certified end-to-end
automation. Check generated claims against separately captured source content.

## Augmentor features used

- [#237 Workflow recipe documentation](../augmentor-future-list-acceptance-matrix.md#automation)
  — available; execution depends on the bounded capabilities below
- [#218 Page content analysis / Q&A](../augmentor-future-list-acceptance-matrix.md#web-understanding)
  — supported
- [#221 One-click / question-driven summaries](../augmentor-future-list-acceptance-matrix.md#summarization-research)
  — supported
- [#227 Research-trail save and archive review handoff](../augmentor-future-list-acceptance-matrix.md#summarization-research)
  — partial save/review foundation; broader acceptance remains open
- [#232 Spreadsheet and document artifact contract](../augmentor-future-list-acceptance-matrix.md#multi-model-backend-provider-routing)
  — open artifact-contract acceptance work; proof required
- [#228 Living Archive context continuity acceptance proof](../augmentor-future-list-acceptance-matrix.md#cross-tab-intelligence)
  — restores saved state; does not reopen or verify live tabs

## Safe automated steps

The Augmentor can:

- Read each readable product page separately and extract specifications, price,
  warranty, and bounded review excerpts with citations (`#218`).
- Save captured source pages as a research trail for archive review (`#227`).
  This does not itself save a generated comparison.
- Restore explicitly saved state after a restart (`#228`); the human reopens
  and verifies current pages and prices.

Cross-source comparison and decision notes are human-reviewed goals using those
separately captured sources and the human's constraints. Tab provenance alone
does not establish grounded comparison, and #232 artifact acceptance remains open.

## Human-only checkpoints

The Augmentor **must not** perform any of these autonomously:

- **Purchase** any product (cart checkout, one-click buy, saved payment).
- **Add to cart** on any shared or family account.
- **Pay** for a warranty, subscription, or protection plan.
- **Apply** any coupon, promo code, or store credit on the human's behalf.
- **Sign in** to an account or vendor portal on the human's behalf.
- **Send** a question or contact-form message to a vendor about a personal
  order.
- **Type** into payment, billing, address, or credential fields.
- **Share** the comparison to a public forum or social account.

Every one of those steps stops for an explicit human handoff per
[AGENTS.md](../../AGENTS.md) and the
[Augmentor tester runbook](../augmentor-tester-runbook.md#4-human-only-boundaries-verify-these-refuse).
The decision notes are **not** a confirmed order; they are a draft the human
takes to the vendor site.

## Suggested prompts

- "Summarise this product page: name, key specs, price, warranty, and bounded
  review excerpts. Cite the source and flag missing details."
- "Using my separately captured summaries, draft a comparison for me to check:
  under $700, two USB-C ports, and a 30-day return policy."
- "Capture the source pages for archive review; I will retain and check
  the generated comparison separately."
- "Show the restored saved context tomorrow so I can verify the live pages,
  current prices, and comparison myself."

## Evidence to capture

- The separately captured summaries and human-checked comparison with source citations.
- The Living Archive intake item id for the research trail.
- A screenshot of the human-only checklist above being shown in the side
  panel after the human reviews the decision notes.

## Safety boundaries & references

- [AGENTS.md trust boundaries](../../AGENTS.md#secrets-and-local-state)
- [Product Guide — Run A Browser Task](../product/PRODUCT_GUIDE.md#run-a-browser-task)
- [Augmentor tester runbook — human-only boundaries](../augmentor-tester-runbook.md#4-human-only-boundaries-verify-these-refuse)
- [Future List acceptance matrix — Multi-step workflows](../augmentor-future-list-acceptance-matrix.md#automation)
- [Future List acceptance matrix — Summarization & research](../augmentor-future-list-acceptance-matrix.md#summarization-research)
