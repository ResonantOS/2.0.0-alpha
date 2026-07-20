# ADR-024: Add-on Store And Commerce Model

## Decision Metadata

- Decision status: Accepted
- Alpha applicability: Deferred
- Superseded by: None
- Owner: Add-on store
- Decision date: 2026-04-28
- Alpha note: Store and commerce behavior is not Alpha scope.

## Decision

ResonantOS should evolve from the current functional Add-ons workspace into a richer Add-on Store experience, similar in product intent to an app store, while keeping the Add-on Registry as the underlying trust and distribution authority.

The Add-on Store is the user-facing discovery and purchase layer.

The Add-on Registry remains the system-facing provenance, review, compatibility, artifact, and capability layer.

The Store must not bypass:

- SDK manifest validation
- registry review state
- provenance verification
- explicit capability grants
- wallet/signing approval flows
- Living Archive boundaries
- provider routing boundaries

## Why

The current Add-ons workspace is functional but not compelling enough for a mature ecosystem.

Users need to understand what an add-on does before installing it. A store-style interface can communicate this through:

- screenshots
- short videos or demos
- feature highlights
- compatibility status
- reviews and ratings
- creator identity
- pricing, subscription, or purchase options
- clear capability and privacy explanations

This matters because ResonantOS is intended to support community add-ons, first-party add-ons, paid add-ons, and user-owned private add-on collections.

## Product Rules

- Store presentation is separate from installation authority.
- A beautiful store page does not imply trust.
- Ratings and screenshots are discovery metadata, not security metadata.
- Community ratings must never override registry review, signature, checksum, compatibility, or capability policy.
- Paid add-ons still require explicit install and capability approval.
- Free add-ons still require explicit install and capability approval.
- Store UI must expose capability risk in plain user language.
- Store UI should make the best path easy while preserving advanced inspection for technical users.

## Store Metadata

Future store entries should support:

- add-on id
- display name
- icon
- screenshots
- demo media
- short tagline
- long description
- feature list
- creator profile
- source repository URL when public
- support URL
- documentation URL
- category
- tags
- platform compatibility
- current version
- changelog summary
- rating aggregate
- review count
- install count or adoption signal when appropriate
- pricing model
- entitlement requirements
- registry review state
- provenance tier
- verification state
- requested capabilities with human-readable rationale

## Ratings And Reviews

Community ratings and reviews may be added after identity, moderation, abuse, and versioning rules exist.

Required rules:

- ratings must be tied to a specific add-on id and version range
- reviews should disclose whether the reviewer installed or used the add-on
- rating metadata must be clearly marked as community feedback
- security review state must remain separate from community sentiment
- low ratings must not automatically disable an add-on
- severe safety reports may trigger registry review, de-listing, or warning states

## Commerce And Wallet Integration

When wallet and web3 capabilities exist, the Store may support paid add-ons, subscriptions, creator payouts, and token-gated add-ons.

Required rules:

- purchase and subscription flows must go through ResonantOS wallet/security services
- add-ons cannot receive raw signing authority
- add-ons cannot silently subscribe, renew, or purchase
- every payment/signing action requires a clear user approval flow
- entitlements must be host-mediated and auditable
- license checks must not grant extra capabilities by themselves
- revoking an entitlement must not delete user data without explicit user approval

Supported future commerce models may include:

- free
- one-time purchase
- recurring subscription
- donation/tip
- token-gated access
- enterprise/private entitlement

## Store Interface Direction

The future Add-on Store should use a two-level interface:

- a visual discovery grid for browsing add-ons
- a detailed add-on page for install, trust, media, reviews, pricing, and capability inspection

The discovery grid should prioritize:

- add-on icon and name
- screenshot or visual preview
- short benefit statement
- category
- rating
- price/free label
- install state
- trust badge

The Store should later support a richer Glocal-style discovery mode:

- advanced search
- filter facets
- timeline view
- world-map view
- relationship graph view
- AI-assisted discovery through Augmentor

This mode should be reusable beyond add-ons. The same product pattern can support the Living Archive, research datasets, community directories, marketplaces, and domain-specific add-ons such as Glocal Music.

The detail page should include:

- screenshots/media carousel
- creator and provenance
- feature explanation
- capability explanation
- compatibility status
- registry review state
- community reviews
- pricing/subscription status
- install/update/disable controls
- link to ask Augmentor about the add-on

## Implementation Consequences

- Registry V0 should remain simple and safety-focused.
- Store metadata should be added as an extension layer, not forced into the core manifest immediately.
- Add-on manifests should remain install/runtime contracts, not marketing pages.
- The curated registry can reference store metadata, media, ratings, and commerce records.
- Wallet work must land before paid add-ons or subscriptions are enabled.
- Store UI should not be built as a monolithic Add-ons page; it needs modular cards, detail views, media components, review components, and commerce components.

## Near-Term Scope

Do not build commerce in the current alpha.

Near-term acceptable work:

- define store metadata types
- allow optional screenshots/icons in registry entries
- redesign the Add-ons workspace toward a store-like visual layout
- keep install, enable, and grant flows unchanged
- add `Ask Augmentor about this add-on`
- add placeholder trust/rating areas clearly marked as not active

Related documents:

- `ADR-006: Add-on Runtime & SDK`
- `ADR-008: Wallet / Web3 Security`
- `ADR-018: Add-on SDK V0`
- `ADR-023: Add-on Repository And Registry Model`
- `docs/product/PRODUCT_GUIDE.md` and the issue-linked `docs/ROADMAP.md`
