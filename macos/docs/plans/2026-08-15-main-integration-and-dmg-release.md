# Main Integration and DMG Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the verified macOS OpenBot work into the repository's main branch without overwriting the collaborator's Windows work, then build, privacy-audit, sign, notarize, staple, install-test, and publish the exact versioned DMG.

**Architecture:** A temporary integration branch is created from the current `origin/main` and receives a non-squashed merge of `macos/codex-bot`. Path ownership and conflict checks run before any main push. The DMG is built only from the resulting pushed main commit and is promoted only when bundle allowlist, privacy, signature, notarization, Gatekeeper, clean-install, direct-Codex, Free Local Desktop, and permitted Cursor-remote gates agree.

**Tech Stack:** Git, GitHub HTTPS remote, Node.js 22.13+, Electron ASAR patcher, Swift/Xcode toolchain, Developer ID Application signing, `notarytool`, `stapler`, `spctl`, `hdiutil`, GitHub Releases.

## Global Constraints

- Never force-push, rewrite collaborator history, delete branches, reset shared work, or resolve a conflict by replacing the Windows side wholesale.
- Fetch before comparison; treat `origin/main` as authoritative for collaborator changes.
- The macOS feature must stay within `macos/` plus explicitly reviewed shared metadata/docs; every Windows/shared-file change requires line-level adjudication.
- Merge and push main before building the release DMG, as requested.
- Build from the exact pushed main commit; record commit, version, bytes, and SHA-256.
- Do not package profiles, credentials, bookmarks, grants, workspaces, caches, logs, evidence frames, developer paths, signing keys, notarization profiles, or source-tree leftovers.
- Do not publish Cursor Remote Computer unless the legitimate account/entitlement live gate passes and redistribution permission is confirmed. A local-only DMG may ship with Cursor mode omitted/disabled and truthfully documented.
- Do not claim notarization, installed-app behavior, direct Codex independence, local desktop, or remote VM behavior from source tests alone.

---

### Task 1: Freeze and Classify the Integration Diff

**Files:**
- Create: `macos/docs/reports/main-integration-audit.md`
- Read-only comparison: all paths changed between `origin/main` and `macos/codex-bot`

**Interfaces:**
- Produces an audit table `{ path, owner: macos|windows|shared, macCommit, mainCommit, action }`.
- Produces exact base, main, and macOS commit IDs.

- [ ] **Step 1: Prove a clean macOS branch and fetch without mutation of worktree files**

```bash
git status --porcelain=v1
git fetch --prune origin
git rev-parse macos/codex-bot origin/main origin/macos/codex-bot
git merge-base macos/codex-bot origin/main
```

Expected: clean tracked tree; all four commit lookups succeed. If authentication or network fails, integration is `BLOCKED` before any merge.

- [ ] **Step 2: Generate exact path and conflict previews**

```bash
git diff --name-status "$(git merge-base macos/codex-bot origin/main)"..macos/codex-bot
git diff --name-status "$(git merge-base macos/codex-bot origin/main)"..origin/main
git merge-tree "$(git merge-base macos/codex-bot origin/main)" macos/codex-bot origin/main
```

Expected: every changed path is classified; no output is silently discarded.

- [ ] **Step 3: Write the integration audit**

The report must list every overlapping shared path and its chosen line-level resolution. Any Windows-owned source overlap is resolved by retaining current main and adapting macOS code around it. Unknown ownership is `BLOCKED`, not guessed. The report contains no credentials or remote URLs with embedded auth.

- [ ] **Step 4: Commit the audit on the macOS branch**

```bash
git add macos/docs/reports/main-integration-audit.md
git commit -m "docs(mac): audit main integration scope"
```

---

### Task 2: Build and Verify a Temporary Main-Based Merge Candidate

**Files:**
- Modify only conflict-resolved files identified in Task 1.
- Test: existing macOS and repository suites.

**Interfaces:**
- Produces branch `integration/openbot-macos-0.2.0` based on the exact recorded `origin/main`.
- Produces a merge commit with parent 1 from main and parent 2 from `macos/codex-bot`.

- [ ] **Step 1: Create the integration branch and merge without committing automatically**

```bash
git switch --create integration/openbot-macos-0.2.0 origin/main
git merge --no-ff --no-commit macos/codex-bot
```

Expected: either a staged clean merge or explicit conflicts. Do not use `-X ours`, `-X theirs`, checkout-whole-tree, or reset.

- [ ] **Step 2: Resolve each conflict using the Task 1 audit**

For a shared file, preserve all non-conflicting main/Windows entries and add only the macOS-specific entry. Validate no unresolved markers:

```bash
git diff --check
git diff --name-only --diff-filter=U
rg -n '^(<<<<<<<|=======|>>>>>>>)' . --glob '!macos/docs/reports/main-integration-audit.md'
```

Expected: no unresolved files or markers.

- [ ] **Step 3: Run shared and macOS verification before the merge commit**

```bash
cd macos
npm test
npm run check
cd ..
git diff --check
```

Run the repository root test/build command documented by current `origin/main` as well. Expected: all functional tests pass; any load-only timing failure must pass exact isolated rerun and a clean required aggregate rerun before proceeding.

- [ ] **Step 4: Commit and verify parent topology**

```bash
git commit -m "merge: integrate macOS OpenBot"
git show --summary --pretty=raw HEAD
```

Expected: exactly two parents in the intended main/macOS order.

- [ ] **Step 5: Re-run exact verification from the committed merge**

```bash
cd macos && npm test && npm run check
cd .. && git diff --check && git status --porcelain=v1
```

Expected: green and clean.

---

### Task 3: Update Main Without Overwriting Collaborator Work

**Files:**
- Git refs only; no new source change is permitted in this task.

**Interfaces:**
- Consumes: verified integration merge from Task 2.
- Produces: `origin/main` at the exact verified merge commit.

- [ ] **Step 1: Confirm remote main has not moved**

```bash
git fetch origin main
test "$(git rev-parse HEAD^1)" = "$(git rev-parse origin/main)"
```

Expected: equality. If main moved, abandon no work; recreate Task 2 from the new main and rerun all gates.

- [ ] **Step 2: Verify authentication and push the integration commit to main without force**

```bash
git push origin HEAD:main
```

Expected: normal fast-forward of remote main to the merge commit. No force flags or refspec deletion.

- [ ] **Step 3: Verify remote truth and preserve the macOS branch**

```bash
git fetch origin main
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
git branch -vv
```

Expected: remote main equals the verified commit; `macos/codex-bot` and the collaborator's branches remain intact.

---

### Task 4: Build, Audit, Sign, and Notarize the DMG From Main

**Files:**
- Generated, ignored staging and artifact paths only.
- Append: `macos/docs/reports/release-0.2.0-macos.1.md`

**Interfaces:**
- Consumes exact pushed main commit from Task 3.
- Produces `OpenBot-0.2.0-macos.1.dmg` and report fields `{ commit, version, bytes, sha256, memberCount, privacyMatches, signingIdentityHash, notarizationId, staple, gatekeeper }`.

- [ ] **Step 1: Verify the configured signing/notarization prerequisites without exposing secrets**

```bash
security find-identity -v -p codesigning
xcrun notarytool history --keychain-profile OpenBot-Notary --output-format json
xcodebuild -version
```

Expected: a valid Developer ID Application identity, working keychain profile, and Xcode tools. Reports record only identity/team hash and notarization request ID, never key material or Apple credentials.

- [ ] **Step 2: Build installer and DMG from the exact main commit**

```bash
cd macos
OPENBOT_RELEASE_INPUTS=/Users/harlin/Library/Caches/OpenBot/release-inputs/0.2.0-macos.1
OPENBOT_RELEASE_STAGE=/Users/harlin/Library/Caches/OpenBot/builds/0.2.0-macos.1-release
OPENBOT_INSTALLER_ROOT="$OPENBOT_RELEASE_STAGE/installer"
OPENBOT_INSTALLER_APP="$OPENBOT_INSTALLER_ROOT/Install OpenBot.app"
OPENBOT_DMG="$OPENBOT_RELEASE_STAGE/OpenBot-0.2.0-macos.1.dmg"
OPENBOT_SIGNING_IDENTITY='Developer ID Application: Harlin Sidwell (HKCH65M45F)'
node scripts/build-installer-app.cjs --release \
  --output "$OPENBOT_INSTALLER_ROOT" \
  --sidecar "$OPENBOT_RELEASE_INPUTS/cli-proxy-api" \
  --sidecar-license "$OPENBOT_RELEASE_INPUTS/CLIProxyAPI-LICENSE" \
  --codex-archive "$OPENBOT_RELEASE_INPUTS/codex-aarch64-apple-darwin.tar.gz" \
  --codex-runtime "$OPENBOT_RELEASE_INPUTS/codex-aarch64-apple-darwin" \
  --codex-license "$OPENBOT_RELEASE_INPUTS/CODEX-LICENSE" \
  --signing-identity "$OPENBOT_SIGNING_IDENTITY"
node scripts/package-dmg.cjs --release \
  --installer-app "$OPENBOT_INSTALLER_APP" \
  --output "$OPENBOT_DMG" \
  --signing-identity "$OPENBOT_SIGNING_IDENTITY"
```

Expected: scripts refuse dirty trees, wrong commit/version, unverified vendor input, unexpected members, unsigned nested code, or missing licenses.

- [ ] **Step 3: Run exhaustive privacy and bundle audits before notarization**

```bash
cd macos
OPENBOT_RELEASE_STAGE=/Users/harlin/Library/Caches/OpenBot/builds/0.2.0-macos.1-release
OPENBOT_INSTALLER_APP="$OPENBOT_RELEASE_STAGE/installer/Install OpenBot.app"
OPENBOT_DMG="$OPENBOT_RELEASE_STAGE/OpenBot-0.2.0-macos.1.dmg"
node scripts/audit-release.cjs --dmg "$OPENBOT_DMG" --expected-app 'Install OpenBot.app'
codesign --verify --deep --strict --verbose=4 "$OPENBOT_INSTALLER_APP"
spctl --assess --type execute --verbose=4 "$OPENBOT_INSTALLER_APP"
hdiutil verify "$OPENBOT_DMG"
```

Expected: exact allowlist, zero personal/secret matches, valid signatures, and valid DMG. The audit scans every member and raw binary bytes, not only small text files.

- [ ] **Step 4: Submit, wait, staple, and re-verify**

```bash
OPENBOT_DMG=/Users/harlin/Library/Caches/OpenBot/builds/0.2.0-macos.1-release/OpenBot-0.2.0-macos.1.dmg
xcrun notarytool submit "$OPENBOT_DMG" --keychain-profile OpenBot-Notary --wait --output-format json
xcrun stapler staple "$OPENBOT_DMG"
xcrun stapler validate "$OPENBOT_DMG"
spctl --assess --type open --context context:primary-signature --verbose=4 "$OPENBOT_DMG"
```

Expected: Accepted, staple valid, Gatekeeper accepted.

- [ ] **Step 5: Record immutable artifact facts**

```bash
OPENBOT_DMG=/Users/harlin/Library/Caches/OpenBot/builds/0.2.0-macos.1-release/OpenBot-0.2.0-macos.1.dmg
shasum -a 256 "$OPENBOT_DMG"
stat -f '%z' "$OPENBOT_DMG"
```

Write only the exact commit/version/size/hash and sanitized verification outcomes to the release report, then commit the report to main and push normally after rerunning `git diff --check`.

---

### Task 5: Verify a Clean Installed App and Both Computer Modes

**Files:**
- Generated disposable install profile and sanitized evidence only.
- Append results to `macos/docs/reports/release-0.2.0-macos.1.md`.

**Interfaces:**
- Consumes: exact stapled DMG from Task 4.
- Produces installed acceptance for direct Codex, Free Local Desktop, and permitted Cursor Remote Computer.

- [ ] **Step 1: Install to a fresh verifier-owned application path and userData profile**

Mount the DMG read-only, run its installer, and choose the unique verifier-owned destination directory `~/Applications/OpenBot Verify 0.2.0-macos.1/`, producing `~/Applications/OpenBot Verify 0.2.0-macos.1/OpenBot.app`. Launch with a unique OpenBot verifier userData directory and verify no stale installed app/process/profile is used. Do not overwrite `/Applications/OpenBot.app`, `~/Applications/OpenBot.app`, or personal profiles during acceptance.

- [ ] **Step 2: Prove direct Codex independence**

With ChatGPT.app closed and no CLIProxy process, use the official OpenBot Codex account, list the authoritative model catalog, send a bounded prompt, and verify the selected tuple and response. Record `CLIPROXY_BEFORE=0` and `CLIPROXY_AFTER=0` without recording process arguments or credentials.

- [ ] **Step 3: Prove Free Local Desktop live**

Run `npm run verify:free-local-desktop` against the installed verifier app. Expected: explicit setup choice, YouTube local frame, per-bot deny/once/always/revoke isolation, subagent workspace isolation, and exact cleanup all pass.

- [ ] **Step 4: Prove Cursor Remote Computer only when permitted**

Run `npm run verify:cursor-forever-box` through the normal account UI. Expected: PASS only with legitimate entitlement and confirmed redistribution permission. Otherwise record `BLOCKED` and ensure the release build omits/disables Cursor mode before publication.

- [ ] **Step 5: Remove only verifier-owned resources**

Quit the verifier app, unmount the exact DMG mount, move the exact verifier app/profile to Trash, and prove no verifier process/window/helper remains. Do not delete cached vendor inputs, personal profiles, other app installs, or another task's temp directories.

---

### Task 6: Publish the Exact DMG to the Versioned Release

**Files:**
- GitHub release metadata and DMG asset only.

**Interfaces:**
- Consumes: pushed main commit, exact audited DMG, release report, version, size, and SHA-256.
- Produces: versioned GitHub release/tag and asset whose downloaded bytes match the audited local DMG.

- [ ] **Step 1: Confirm the repository's version/tag convention and absence of collisions**

```bash
git fetch --tags origin
git tag --list
gh release list --repo LimonLimez/Codex-Bot
```

Expected: existing public tags end at `v0.1.5` and `v0.2.0` does not exist. If `v0.2.0` appears before publication, stop for version review rather than overwrite it.

- [ ] **Step 2: Create the annotated tag at the pushed main commit**

```bash
OPENBOT_MAIN_COMMIT="$(git rev-parse origin/main)"
git tag -a v0.2.0 "$OPENBOT_MAIN_COMMIT" -m "OpenBot macOS 0.2.0"
git push origin v0.2.0
```

Expected: `v0.2.0` points to the tested main commit.

- [ ] **Step 3: Create the release and upload the DMG**

```bash
OPENBOT_DMG=/Users/harlin/Library/Caches/OpenBot/builds/0.2.0-macos.1-release/OpenBot-0.2.0-macos.1.dmg
gh release create v0.2.0 "$OPENBOT_DMG" \
  --repo LimonLimez/Codex-Bot \
  --title "OpenBot 0.2.0 macOS" \
  --notes-file macos/docs/reports/release-0.2.0-macos.1.md
```

Release notes state which Computer modes passed and which remain blocked. They include the SHA-256 and do not include local paths, account identifiers, credentials, or private diagnostics.

- [ ] **Step 4: Download and re-hash the published asset**

```bash
OPENBOT_DOWNLOAD_DIR="$(mktemp -d /tmp/openbot-release-download.XXXXXX)"
gh release download v0.2.0 --repo LimonLimez/Codex-Bot --pattern '*.dmg' --dir "$OPENBOT_DOWNLOAD_DIR"
OPENBOT_DOWNLOADED_DMG="$OPENBOT_DOWNLOAD_DIR/OpenBot-0.2.0-macos.1.dmg"
shasum -a 256 "$OPENBOT_DOWNLOADED_DMG"
hdiutil verify "$OPENBOT_DOWNLOADED_DMG"
xcrun stapler validate "$OPENBOT_DOWNLOADED_DMG"
```

Expected: downloaded SHA-256 exactly matches Task 4, DMG verifies, staple validates. If any mismatch occurs, stop and remove only the incorrect new release asset; do not alter prior releases.

- [ ] **Step 5: Final repository truth check**

```bash
git fetch origin main --tags
git status --porcelain=v1
git rev-parse HEAD origin/main v0.2.0
```

Expected: clean worktree and all three commit IDs equal the verified release commit.
