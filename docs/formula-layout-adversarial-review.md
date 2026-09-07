# Formula layout repair / 2026-09-07

Scope: shared formula image renderer only. No model, provider, Bot identity,
agent integration, or proxy changes. Stable release target: 0.8.20.

## Three-month failure review

1. **A formula introduces a KaTeX class that collides with card CSS.**
   Reproduced with `\\neq`: internal `.inner` inherited a 1112px white card
   with a 7px blue border. Namespace all application layout classes with
   `cf-`, remove the global box-sizing reset, and retain KaTeX's own CSS.
   Browser regression exercises neq, notin, not-subset and fractions,
   asserting internal padding/borders/width, not just PNG existence.
2. **More complex content overflows after narrowing images for readability.**
   Separate default widths: block 640, prose 800, table 1100 CSS pixels;
   use 2x raster density. Wait for layout and measure formula bases relative
   to their cell/container. Widen within 1600px; if still too wide or taller
   than 6000px, use the existing readable fallback and preserve LaTeX sources.
   Tests cover short formulas, mixed tables, matrices and an oversized
   unbreakable underbrace. This is bounded fitting, not smart pagination.
3. **Fonts fail or malformed LaTeX is uploaded as apparent success.**
   Force layout, wait for font loading within the render deadline, reject
   failed FontFace entries, and enable KaTeX throwOnError. A broken embedded
   font and invalid command are negative tests. The actual service regression
   verifies zero uploads, one failure and retained source for invalid input.

## Verification

- Existing formula unit suite and real service PNG smoke tests.
- New real-browser test/formula-layout.test.mjs, three adversarial subtests.
- Full root checks and desktop checks before release.
- No external image requests or real chat sends in tests; smoke PNG files
  reside in an OS temporary directory and are removed in finally blocks.

## Limits

Desktop and mobile still receive the same image. Wide tables may require
opening the original image on a phone. Previously sent images do not change.
Arbitrary TeX, semantic correctness of model output, and automatic pagination
are not guaranteed. Errors preserve formula source through existing fallback.
