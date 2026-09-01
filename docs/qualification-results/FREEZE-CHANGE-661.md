# Deliberate freeze change — #661, machine-checkable Tier 1 adjudication

`freeze.json` was regenerated with `npm run qualify:validate -- --write`. Its own note
requires saying why. This is that statement.

| | |
| --- | --- |
| Old `freeze.json` SHA-256 | `7b1df40bfddc8f1f14deacd22bdca88ca5063843bab66e99ba8d7ec7a928ebe3` |
| New `freeze.json` SHA-256 | `f71cdd443edf97760103f41b0d72816843a736f5dd95edaf79f1ef478b05f17e` |
| Old manifest entries | 21 |
| New manifest entries | 22 |
| Files added | 1 |
| Files whose bytes changed | 1 |
| Files removed | 0 |
| Files untouched | 20 of 21 |

## Why

Tier 1 carries frozen requirements written in English — "the artifact must state that no
on-disk matcher cache exists", "… is neither present in the graph nor declared as
unresolved". The evaluator tried to decide those by looking for negation words and subject
mentions in artifact prose. That is not decidable by matching, and it failed in both
directions: *"There is no doubt that an on-disk matcher cache exists"* satisfied the
absence check, and *"supporting evidence for src/hono.ts"* suppressed a false-ready
condition. An independent review held the work twice on exactly this.

The maintainer ruling was to stop inferring meaning from prose and give the evaluator
explicit typed predicates instead.

## What changed

### Added — `docs/qualification/tier1-adjudication.json`

SHA-256 `3f6ac7055d00fefc4796a87e4c21137f93b9a1697bdf675d0261d7936592b136`.

It binds each of the **17** Tier 1 prose clauses, by the SHA-256 of that clause's exact
bytes, to exactly one deterministic predicate drawn from a closed union of eight kinds.
It contains no observed Madar output, no generated claim text, no current cell state, no
expected answerability value and no threshold. Its inputs are the existing frozen prose,
the existing frozen paths, symbols, facts and obligations, and stable artifact schema
semantics.

The predicate union deliberately excludes `prose_matches`, `semantic_text_match`,
`natural_language_assertion`, negation-marker matching and unrestricted regex. A kind
outside the union refuses the run, so no natural-language predicate can be reintroduced
by editing the contract alone. No model or embedding call is involved.

### Changed — `docs/qualification/tier1.json`

Two additive keys only: `adjudication_ref` (so the companion is discovered rather than
hardcoded) and `adjudication_note`.

Verified byte-equal after the edit: `contract_version`, `frozen_at`, `purpose`,
`properties`, `preparation`, `cells`, `negative_trust_probes` (including every prompt,
prompt hash, ground truth and `required_behaviour` sentence), `gate` and
`calibration_status`.

### Not changed

Every truth file, every prompt and prompt hash, every target SHA, every patch, every
`required_evidence_paths` / `required_evidence_symbols` list, every
`min_critical_fact_recall`, every prohibited claim, every `required_behaviour` sentence
and every `must_not_report_ready_when` sentence. `receipt-schema.json` is untouched: it
governs the example run receipts, not the Tier 1 result file, so it does not need to
carry the adjudication identity.

## Clause inventory

All 17 Tier 1 prose clauses are bound. None was dropped as "human-only".

| Classification | Count | Predicate kinds used |
| --- | --- | --- |
| Already machine-checkable, now stated explicitly | 8 | `answerability_not_in`, `prohibited_reference_absent`, `required_evidence_paths_present`, `explicit_path_present` |
| Required structured adjudication | 9 | `required_typed_absence`, `prohibited_substitution_absent`, `must_not_ready_when_requirements_missing` |
| Human / Tier-2 only | 0 | — |

## What this does not do

It does not make any cell pass. A requirement that the product cannot currently express
in a typed channel now fails with an exact reason — `missing_required_absence_declaration`
— rather than being rescued by a sentence or excused as unmeasurable. That is the point.
