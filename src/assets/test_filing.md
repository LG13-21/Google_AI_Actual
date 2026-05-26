# Vzorový právní podání — PoC F15.4

**Spisová značka:** 0 P 29/2026 (sample)
**Datum:** 2026-05-07
**Účel:** Test pipeline MD → HTML + PDF + ZIP (GitHub Actions PoC)

## I. Úvod

Toto je vzorový dokument pro ověření build pipeline `lg13-build-from-atoms`.
Cíl: nahradit ruční rebuild MD→PDF (3h, tisíce tokenů per F-cyklus) plně automatizovaným CI.

## II. Test diakritiky

Ověření českých znaků: žluťoučký kůň úpěl ďábelské ódy.
Speciální: §, ©, ®, €, ½, →, ←, ≥, ≤.

## III. Test struktury

### III.1 Nadpis úrovně 3

Odstavec s **tučným** a *kurzívou* textem.

- Položka 1
- Položka 2
  - Vnořená položka

### III.2 Tabulka

| Sloupec A | Sloupec B | Sloupec C |
|-----------|-----------|-----------|
| řádek 1   | hodnota   | 100 Kč    |
| řádek 2   | hodnota   | 250 Kč    |

### III.3 Citace

> Tom directive 5.5.2026 ~08:05 UTC: „delate veci porad dokola rucne 3hod za tisice tokenu".

## IV. Závěr

PoC ověří: (1) pandoc render MD→HTML s embedded CSS, (2) pandoc render MD→PDF přes XeLaTeX s CZ fonty, (3) zip do `out/KOMPLET.zip`, (4) upload artifactů.

---

*Generováno PoC pipeline F15.4 — task #2563*
