# Recipe: Travel planning

Travel-planning example from the Augmentor Future List. Compares candidate
hotels, flights, or itineraries across tabs, builds a decision packet,
and stops for human review before any booking or payment.

## Goal

Open several candidate hotels, flights, or itinerary pages in tabs, gather
their price ranges, cancellation policies, and review summaries, and produce
a single decision packet the human can review before booking.

Goals and prompts describe intended workflows, not certified end-to-end
automation. Check generated claims against separately captured source content.

## Augmentor features used

- [#237 Workflow recipe documentation](../augmentor-future-list-acceptance-matrix.md#automation)
  — available; execution depends on the bounded capabilities below
- [#218 Page content analysis / Q&A](../augmentor-future-list-acceptance-matrix.md#web-understanding)
  — supported
- [#220 Cross-tab comparison with tab provenance](../augmentor-future-list-acceptance-matrix.md#cross-tab-intelligence)
  — needs hardening; provenance does not establish captured-content comparison
- [#227 Research-trail save and archive review handoff](../augmentor-future-list-acceptance-matrix.md#summarization-research)
  — partial save/review foundation; broader acceptance remains open
- [#228 Living Archive context continuity acceptance proof](../augmentor-future-list-acceptance-matrix.md#cross-tab-intelligence)
  — restores saved state; does not reopen or verify live tabs

## Safe automated steps

The Augmentor can:

- Read each readable candidate page separately and extract price, cancellation
  policy, amenities, and review text with source citations.
- Save captured source pages as a research trail for archive review (`#227`);
  that capture does not itself save a generated comparison or decision packet.
- Restore explicitly saved state after a restart (`#228`); the human reopens
  and verifies live tabs.

Option ranking and decision packets are goals requiring human checking against
the captured sources and current prices. They are not shipped booking-packet
functionality under deferred #244.

## Human-only checkpoints

The Augmentor **must not** perform any of these autonomously:

- **Book** a flight, hotel, car, rail, or tour reservation.
- **Pay** for any travel reservation (credit card, wallet, third-party).
- **Send** an email or contact-form message to a venue, host, or concierge.
- **Add** the trip to a calendar.
- **Sign in** to a booking account or loyalty program on the human's behalf.
- **Type** into payment, billing, or credential fields.

Every one of those steps stops for an explicit human handoff per
[AGENTS.md](../../AGENTS.md) and the
[Augmentor tester runbook](../augmentor-tester-runbook.md#4-human-only-boundaries-verify-these-refuse).
The decision packet is **not** a confirmed booking — it is a draft the human
takes to the booking site.

## Suggested prompts

- "Summarise this candidate page: nightly rate, total cost for our dates,
  cancellation policy, and review-score. Cite the source; flag missing details."
- "Using my separately captured summaries, propose a ranking for human review:
  under $250/night, free cancellation, walkable to the venue."
- "Capture the source pages as a research trail for archive review; I will
  retain and check the proposed comparison separately."
- "Show the restored saved context after restart so I can reopen and verify
  the live pages and prices myself."

## Evidence to capture

- The human-checked option ranking with captured source citations.
- The Living Archive intake item id for the captured research trail.
- A screenshot of the human-only checklist above being shown in the side
  panel after the human reviews the decision packet.

## Safety boundaries & references

- [AGENTS.md trust boundaries](../../AGENTS.md#secrets-and-local-state)
- [Product Guide — Run A Browser Task](../product/PRODUCT_GUIDE.md#run-a-browser-task)
- [Augmentor tester runbook — human-only boundaries](../augmentor-tester-runbook.md#4-human-only-boundaries-verify-these-refuse)
- [Future List acceptance matrix — Multi-step workflows](../augmentor-future-list-acceptance-matrix.md#automation)
