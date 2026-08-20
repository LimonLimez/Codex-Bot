# Task 6 review-fix report

## Status

Resolved all three Important findings from the Task 6 whole-lane review on
base `22383fa`. The change is source/test/package-closure verified only; no
provider files, build/install/launch state, or release artifacts were touched.

## Root causes and fixes

1. **Bear exceeded the identity bound.** The pinned Grok helper computes
   radial support for each `dBt` circle, then feeds 160 samples through `Mst`.
   The original fourth circle `[ze,ze+78,72]` reaches `ze+150`. The minimal
   compound-silhouette correction keeps the two ears and muzzle/body circle,
   narrows the head circle from `104` to `100`, and moves the muzzle/body
   circle center from `ze+78` to `ze+44`, so the generated curve reaches at
   most `ze+116`. The corrected bear remains symmetric and distinct from the
   stock abstract registry.

2. **Geometry tests stopped at source vertices and trimmed line segments.**
   Both `renderer-integration.test.cjs` and `patch-app.test.cjs` now
   independently reproduce the pinned `eX.corner`/`Ost`, `dBt`, and `Mst`
   algorithms; parse their emitted `Q` and `C` commands; calculate analytic
   quadratic and cubic extrema; sample curves for non-adjacent crossings; and
   reject degenerate paths. Every added identity is checked against the
   required relative `ze ±116` bound, not the old `±129` stock-box check. The
   pre-fix RED run failed on bear at `ze+150`.

3. **Standalone wiring used a stale synthetic renderer.**
   `standalone-desktop-wiring.test.cjs` now includes
   `VENDOR_GEOMETRY_TAIL` and `VENDOR_VISIBLE_SHAPES` exactly once. Its real
   `patchRenderer` exercise reads the patched renderer back and proves exactly
   one OpenBot geometry anchor, one visible-list anchor, and one entry for each
   added shape.

## TDD evidence

Before the production edit:

```text
node --test --test-name-pattern='pinned Sand helper paths stay|pinned path validator rejects' macos/test/renderer-integration.test.cjs
1 passed, 1 failed; expected failure: bear dBt/Mst exceeds ze+116: 150

node --test --test-name-pattern='patch-app validates pinned|patch-app path validator rejects' macos/test/patch-app.test.cjs
1 passed, 1 failed; expected failure: bear dBt/Mst exceeds ze+116: 150
```

After the production edit:

```text
node --test macos/test/avatar-catalog.test.cjs macos/test/renderer-integration.test.cjs macos/test/patch-app.test.cjs macos/test/standalone-desktop-wiring.test.cjs
85 passed, 0 failed
```

## Final verification

```text
node --test macos/test/release-package.test.cjs macos/test/installer-bundle.test.cjs macos/test/patch-app.test.cjs macos/test/renderer-integration.test.cjs macos/test/standalone-desktop-wiring.test.cjs
209 passed, 0 failed, 2 declared skips

npm --prefix macos run check
Checked 152 JavaScript source files.

swift run --package-path macos/installer InstallerCoreTests
7 PASS lines, exit 0

node --check macos/src/patch/renderer.cjs
node --check macos/test/renderer-integration.test.cjs
node --check macos/test/patch-app.test.cjs
node --check macos/test/standalone-desktop-wiring.test.cjs
git diff --check
All passed.
```

The pinned vendor renderer hash constant remains unchanged. The final commit
is recorded below.

## Concerns and remaining gates

- This task intentionally did not build, install, launch, or visually inspect
  the packaged app. Native size/theme/motion/recognizability acceptance remains
  the final integration gate described by the approved Task 6 brief.
- The Swift executable harness is the repository-authored installer acceptance
  boundary; `Package.swift` exposes it as an executable target rather than a
  discovered Swift test target.
- No provider-owned files, runtime/provider behavior, or release/notarization
  claims are part of this fix.

## Commit

Final commit: the VCS commit containing this report and the four authorized
source/test files (reported separately to the parent task; the report avoids a
self-referential hash).
