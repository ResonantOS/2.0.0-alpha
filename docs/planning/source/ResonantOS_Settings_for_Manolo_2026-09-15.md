# ResonantOS — three settings to change

**Subtitle:** Repository and organisation access hardening
**Original file:** `ResonantOS-Settings-for-Manolo.pdf`
**Date:** 15 September 2026
**From:** Tom · For Manolo
**Effort:** about 5 minutes · needs the organisation owner account (only you)

> This file is a verbatim Markdown conversion of the source PDF (page headers and
> footers removed). It is retained as reference material and is **authoritative
> direction** for the current repository-access state. The reconciled,
> execution-oriented view lives in the
> [master implementation plan](../03-master-implementation-plan.md).

---

## Why

The organisation's base permission is Admin, so all 17 members are
administrators of `ResonantOS/2.0.0-alpha`. Any one of them can switch off branch
protection, and possibly delete or transfer the repository. It has 15 forks, so a
deletion probably can't be undone.

Do these in order. Step 1 must come before Step 3, or Tom loses admin access too.

## Step 1 — Make Tom an explicit admin of the repository

- **Location:** Repository settings → Collaborators and teams → Manage access
- **URL:** `github.com/ResonantOS/2.0.0-alpha/settings/access`

Click **Add people** → type `tompennington` → choose role **Admin** → **Add**.

Tom currently has admin only because everyone does. Step 3 removes that, so he
needs his own grant first.

Roles: Read · Triage · Write · Maintain · Admin

## Step 2 — Stop members deleting or transferring repositories

- **Location:** Organisation settings → Member privileges
- **URL:** `github.com/organizations/ResonantOS/settings/member_privileges`

Scroll to **Admin repository permissions** and untick:

- "Allow members to delete or transfer repositories for this organization"
- "Allow members to change repository visibilities" (recommended)

Then **Save**.

After this, only you — the owner — can delete, transfer, or make a repository
private.

## Step 3 — Lower the base permission from Admin to Read

- **Location:** Organisation settings → Member privileges
- **URL:** `github.com/organizations/ResonantOS/settings/member_privileges`

At the top, under **Base permissions**, change **Admin** to **Read** → confirm
the change.

Contributors keep write access through `dev-team`. This applies to every
ResonantOS repository — if anyone needs admin on another repo, grant it to them
directly.

## Step 4 — Require two-factor authentication (recommended)

- **Location:** Organisation settings → Authentication security
- **URL:** `github.com/organizations/ResonantOS/settings/security`

Tick "Require two-factor authentication for everyone in the ResonantOS
organization" → **Save**.

GitHub removes members who don't have 2FA enabled. They can rejoin once they
turn it on.

## When done

Message Tom. He'll confirm from his side that the repository's admins have
dropped from 17 to two — you and him.
