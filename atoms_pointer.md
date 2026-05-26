# Atoms data sources

Primary atoms files are NOT committed here (multi-MB binary-ish JSON, fast-changing).

## Master

- `L:/GitHub/tmonkey/data/processed/atoms.json` — 87K+ atomů, 49.5 MB
- Repo: `LG13-21/tmonkey` private

## Per-target bundles

- `L:/LG13/atoms/by_target/strat/`
- `L:/LG13/atoms/by_target/legal/`
- `L:/LG13/atoms/by_target/coder/`
- `L:/LG13/atoms/by_target/web/`
- `L:/LG13/atoms/by_target/...`

## Per-cycle bundles

- `L:/LG13/atoms/bundles/F<X>_<Y>_<YYYY-MM-DD>.json`
- Format: subset of master atoms relevant for given F-cycle

## Realtime per-conv

- `L:/LG13/atoms/realtime/<conv_id>/atoms.json`
- `L:/LG13/atoms/realtime/<conv_id>/segments.json`

## CLI

- `python L:/LG13/app/agent/atom_lookup.py --instance strat --since 'X' --topic 'Y'`
- HYBRID jsonl fast path + content filters
