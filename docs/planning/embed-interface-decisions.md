# Decisions: external harness interfaces in ResonantOS

Status: approved by Tom Pennington in chat on 2026-10-10. These directions
govern the work on `testing/augmentor-embed-sidecar`. They become an
architecture decision record before any of this reaches `dev`; that record's
number is to be agreed with Andrew von Stegen, because ADR numbers 039 to 057
are already used on his branches. Discussion:
[PR #440 comment](https://github.com/ResonantOS/2.0.0-alpha/pull/440#issuecomment-6093894112).

1. **Manifest vocabulary.** Add-on manifests gain an optional `interfaces[]`
   list. Each entry has a stable ID and one mode: `adapter-chat` (ResonantOS
   chat through a reviewed adapter) or `embed` (the harness's own interface,
   proxied by the bridge). `web` and `terminal` are reserved until a second
   harness needs them. An add-on without the list behaves exactly as today. The
   schema lands with validator tests.
2. **Primary-agent slot.** Choosing an interface never moves the primary-agent
   slot. Switching between a harness's own interface and ResonantOS chat for
   the same harness is a change of view. Switching to a different harness is a
   slot change through the existing compare-and-swap, as ADR-026 requires.
3. **Authority.** Two declared tiers. Governed: every tool call is checked
   against the capability floor. Self-governed: the harness's own approvals
   cover its own tools, and it receives no ResonantOS capability. Anything a
   self-governed harness wants from ResonantOS (memory, Living Archive, files,
   page control, credentials) goes through a mediated, receipted channel. No
   authority laundering: an embed grant, prompt, context message or harness
   approval never authorizes a ResonantOS capability. The bar shows a visible
   self-governed marker.
4. **Consent and retention.** Recorded harness events are metadata only:
   conversation changes, replies started and finished, tool names with an error
   flag. No prompts, tool arguments or results. Page sharing logs the site's
   domain only. Records stay in the local bridge log for 30 days, visible to the
   user and deletable, with a switch to turn recording off. The first time a
   page is shared with an outside harness, a one-time notice names the harness
   and says it runs outside ResonantOS approvals.
5. **Release scope.** Not in the Alpha release. The work stays on the testing
   branch, off by default, targeting beta. It reaches `dev` only after the
   decision record above captures decisions 1 to 4.

## Not built yet

The self-governed marker (3), the event log with retention and the first-share
notice (4), and the `interfaces[]` schema (1) are decided but not implemented on
this branch.
