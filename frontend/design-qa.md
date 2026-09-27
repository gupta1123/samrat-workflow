# Design QA — pre-analysis document controls

## Evidence

- Source reference: `/var/folders/df/_ytqcm0j3g1fl9sl2scxp8x00000gn/T/TemporaryItems/NSIRD_screencaptureui_u44FuH/Screenshot 2026-09-10 at 1.33.31 PM.png`
- Implementation capture: Codex in-app browser tab 1, `http://localhost:8888/workspace`, captured after the case was saved and before analysis.
- Comparison viewport: 1512 × 982 CSS pixels, matching the 3024 × 1964 reference at 2× density.
- Verified state: one saved PDF, `Ready to analyze`, with Remove, Replace, Add documents, Analyze as one case, and Split into separate cases available.

## Visual comparison

- Layout and hierarchy: passed. The existing sidebar, centered success state, document rail, mode label, add action, and two analysis actions retain the reference layout and spacing.
- Typography and colors: passed. New controls use the product's existing text, border, surface, disabled, and focus tokens; no new visual language was introduced.
- Icons and surfaces: passed. The remove control uses the existing Lucide icon family and sits at the document tile's top-right; Replace remains a compact secondary action beneath the tile.
- Copy density: passed. The rail adds only the short `Replace` label; analysis-card copy and the removed recommendation treatment remain unchanged.
- Responsiveness and overflow: passed for the reference desktop viewport. The controls remain within the document card without clipping, overlap, or scroll regression.

## Interaction and accessibility QA

- Saved draft files expose exact accessible labels: `Remove <filename>` and `Replace <filename>`.
- Controls are disabled while a mutation is running and after analysis begins.
- Replacement preserves the current file until the server accepts the new upload; invalid or over-limit replacements fail without losing the original.
- Removal and replacement target the exact server-side file id and are owner-scoped.
- Browser console: no warnings or errors in the verified state.

## Automated verification

- TypeScript typecheck: passed.
- ESLint: passed.
- Full test suite: 137 passed, 0 failed.
- Supabase schema verification: 10/10 core tables, private storage, and local Auth passed.

final result: passed
