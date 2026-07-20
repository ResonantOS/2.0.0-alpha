## Scope

<!-- What changed, why, and what is explicitly out of scope? -->

Linked issue: <!-- Use "Closes #123" or explain why there is no issue. -->

Project 2 release scope:
Project 2 area:

## Modules And Ownership

<!-- List affected paths/modules and the owner from docs/architecture/MODULE-OWNERSHIP.md. -->

- Affected modules:
- Ownership or boundary review:

## Safety And Privacy

<!-- Describe security, privacy, permissions, credentials, personal data, and human-only action impact. Write "None" only after checking. Never paste secrets or private user data. -->

- Safety/privacy impact:
- Required human handoff or approval boundary:
- Secret-handling impact:

## Validation

<!-- List exact commands and results. Do not write only "tests pass". -->

| Command | Result |
| --- | --- |
|  |  |

Live-browser proof: <!-- Link redacted evidence when required, or explain why it is not required. -->

## Documentation

<!-- List documentation changed, or explain why behavior and contributor guidance are unaffected. -->

Documentation impact:

## Checklist

- [ ] The branch targets `dev` and does not include unrelated work.
- [ ] The linked issue and Project 2 fields reflect the intended release scope.
- [ ] I reviewed module ownership and called out every cross-module boundary change.
- [ ] I assessed security, privacy, secrets, and required human-only actions.
- [ ] I added or updated tests for behavior changes.
- [ ] I recorded every relevant command and its actual result above.
- [ ] I attached redacted live-browser proof when the change requires it.
- [ ] I updated current documentation or explained why no documentation changed.
- [ ] This pull request contains no credentials, tokens, private user data, browser profiles, or unredacted sensitive logs.
