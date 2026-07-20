# Security Policy

## Report Privately

Do not open a public issue for a suspected vulnerability.

**Disclosure contact:** Vladimir Rondelli at `rondellivladimir@gmail.com`.

Email that address with the subject prefix
`[SECURITY]`. Include only the minimum information needed to understand and
reproduce the problem:

- affected version or commit;
- affected extension or bridge surface;
- reproduction steps using test data;
- expected impact; and
- a safe way to contact you for follow-up.

Do not send access tokens, provider keys, wallet credentials, cookies, browser
profiles, login databases, private user content, or unredacted production logs.
If sensitive evidence is necessary, first use email to agree on a secure
transfer method. No project PGP key is currently published.

The disclosure contact owns initial triage and coordinates remediation and any
public disclosure. General support, non-sensitive bugs, and feature requests
belong in the public issue forms described in [SUPPORT.md](SUPPORT.md).

## Response Targets

| Stage | Target |
| --- | --- |
| Acknowledge the report | 3 business days |
| Assign severity and scope | 7 business days |
| Provide a fix or mitigation plan for a confirmed high-impact finding | 14 business days |

These are response targets for the active alpha, not a paid support guarantee.
Public disclosure timing is coordinated with the reporter after users have a
reasonable remediation path.

## Supported Security Boundary

Security reports are accepted for the current browser-first alpha:

- the Chrome Manifest V3 side panel, new-tab page, content scripts, background
  service worker, and their message boundaries;
- the authenticated loopback Node.js bridge and its capability tokens;
- provider routing, subprocess invocation, and process environment handling;
- memory-service and local-service listener exposure;
- add-on manifests, capability grants, allowed-tools declarations, and scoped
  bridge APIs; and
- repository and release integrity, including CI credentials, action pinning,
  artifacts, and provenance.

The latest `dev` branch and alpha tags still in active testing receive security
fixes. A third-party dependency report is in scope when it demonstrates impact
on this repository. Social engineering, disruption that requires already
trusted local access, and reports without a plausible repository impact are out
of scope.

## Researcher Expectations

Good-faith research must use accounts and data you are authorized to access.
Do not exfiltrate data, access third-party accounts, disrupt provider services,
modify trusted memory outside disposable test data, bypass required human
approval boundaries, or publish details before coordinated disclosure.

Good-faith work within this policy will not be treated as abuse by the project.
