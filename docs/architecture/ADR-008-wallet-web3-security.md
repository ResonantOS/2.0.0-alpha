# ADR-008: Wallet & Web3 Security

## Decision Metadata

- Decision status: Accepted
- Alpha applicability: Partial
- Superseded by: None
- Owner: Browser safety
- Decision date: 2026-04-23
- Alpha note: Read-only wallet detection and human-only wallet, signing, and
  value-action boundaries apply. Wallet custody and signing are not Alpha
  capabilities, and Rust ownership does not apply.

## Decision

ResonantOS uses a hybrid wallet model:

- local user-controlled wallets are first-class
- managed accounts are optional

The default product philosophy remains sovereignty-first. ResonantOS must not force users into custodial behavior to use web3 features.

Signing and privileged key operations belong on the Rust side. Wallet actions are capability-gated and auditable. Add-ons never receive raw signing power implicitly.

## Why

- The product needs strong security for future wallet, token, and blockchain capabilities.
- Users may want local custody, managed convenience, or both.
- Wallet operations are too sensitive to live in weakly isolated UI-only flows.

## Rules

- Local custody remains a supported primary path.
- Managed accounts may exist, but they are optional.
- Signing authority must be mediated by core services.
- Add-ons may request wallet-related actions, but they do not receive uncontrolled access to keys.
- Every wallet/signing action must be auditable and attributable.
- Wallet key material must follow the Portable User State and secure vault boundary defined in `ADR-022`.

## Custody Tiers

The system must distinguish at least:

- `local-user-controlled`
- `managed-optional`
- optional future `external-connected`

Custody tier affects:

- confirmation requirements
- storage and recovery posture
- risk messaging
- allowed automation level

## Signing Flow

Signing must be an explicit flow:

1. request action
2. evaluate capability and policy
3. identify wallet provider and custody tier
4. present confirmation or automation gate
5. execute signing in Rust-side trusted code
6. record an audit artifact

## Add-on Restrictions

- Add-ons must not get raw secret material by default.
- Add-ons may request:
  - wallet read access
  - transaction construction assistance
  - signing request submission
- Add-ons may not bypass confirmation or policy layers.

## Interfaces Constrained By This ADR

### Wallet Provider Abstraction

Must represent:

- chain or ecosystem
- custody tier
- supported operations
- availability and health

### Signing Request

Must represent:

- requesting actor
- target wallet/provider
- operation type
- payload summary
- required confirmation mode
- audit metadata

### Confirmation / Approval Model

Must support:

- user approval
- policy denial
- optional managed/automated rules where explicitly allowed

## Consequences

- Future wallet features must begin with a Rust-side service contract, not a UI-first prototype.
- Capability vocabulary will need wallet-specific grants and scopes.
- Managed-account support can exist, but cannot become the hidden default operating model.
- Wallet implementation must wait for the encrypted portable vault foundation unless it uses a deliberately temporary non-production mock.
