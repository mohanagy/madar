# GoValidate shared benchmark quality gates

This directory holds the shared pack-quality gates for committed GoValidate benchmark artifacts.

## Files

- `quality-gates.json` — named gate definitions plus the prompt text they apply to
- `verify-pack-quality.js` — deterministic verifier for persisted `graphify-ts compare` reports

## Usage

By gate name:

```bash
node docs/benchmarks/govalidate-suite/verify-pack-quality.js \
  --report path/to/report.json \
  --gate docs-artifact
```

By prompt text:

```bash
node docs/benchmarks/govalidate-suite/verify-pack-quality.js \
  --report path/to/report.json \
  --prompt "Explain how idea report is getting generated"
```

The verifier reads `report.pack`, checks normalized matched-node labels against the required/forbidden lists, enforces the numeric ceilings, prints a deterministic pass/fail summary, and exits non-zero on malformed input or any gate failure. Label matching lowercases and strips non-alphanumeric characters, so gate labels must still contain at least one alphanumeric character after normalization.
