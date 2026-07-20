# HRR-033 Deterministic Certification Gate

This package closes the HRR-033 W5.5 failure mode where certification was based on proposed files or artifact existence alone.

Run:

```bash
node browser-first/test/hrr033-certification/run-certification.mjs
```

The gate writes evidence to:

```text
output/runtime-evidence/context-resonator-remediation-20260704/certification/HRR-033-V61-CONTEXT-RESONATOR-DETERMINISTIC-CERTIFICATION-20260705/
```

What it verifies:

- staged, unstaged, and untracked scope accounting;
- `node --check` for target extension JavaScript files;
- JSON parse validation for Resonant Context and Resonator addon manifests;
- focused browser-first tests by direct `.test.mjs` file, not unsupported `--suite` flags;
- full `npm run test:browser-first` regression;
- cropped user-perspective screenshot proof with hashes, dimensions, nonblank checks, binary sentinel scans, OCR sentinel scans, and pixel-diff checks where visual overlay proof is claimed;
- five-family certification review derived from executed gate outputs, not empty template arrays;
- nonzero process exit for any certification failure.
