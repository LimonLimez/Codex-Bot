# Windows Sandbox acceptance harness

This harness validates the **0.1.4 DEVELOPMENT TEST BUILD** in a disposable,
fresh Windows environment. It is an acceptance aid, not a release-signing or
publishing step. It never enables Windows Sandbox, changes host policy, bypasses
SmartScreen, clicks a permission prompt, or automates authentication.

The emitted elements follow Microsoft's current
[Windows Sandbox `.wsb` configuration reference](https://learn.microsoft.com/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file).

## Safety boundary

- Networking stays enabled because the installer must download the pinned
  vendor-hosted Grok Bot 0.18.0 setup and interactive sign-in uses Cursor and
  OpenAI endpoints.
- vGPU, clipboard, printer, microphone, and camera redirection are disabled.
  Protected Client mode is enabled.
- A staging folder containing exactly the audited installer and checksum
  sidecar is mapped read-only. A separate two-file harness folder is also
  read-only.
- Each scenario receives its own new, empty, writable evidence folder. This is
  the only writable host mapping. Do not place other files in it.
- The generator requires an independently reviewed SHA-256; the sidecar alone
  is not accepted as the trust anchor. It also requires the current Git
  revision in the filename and exact embedded DEVELOPMENT/DO NOT PUBLISH PE
  metadata. It separately requires the independently reviewed SHA-256 of the
  deterministic branded `Codex Bot.exe` entry point.
- The sandbox runner refuses to execute the installer if it finds prior Codex
  Bot, Grok Bot, or Cursor install/state indicators in user or machine paths,
  uninstall/App Paths registry keys, processes, or scheduled tasks.
- Raw Inno Setup logs remain in the disposable VM. Only a line-filtered,
  path-sanitized log is written to evidence. The runner never reads account
  credential files or copies application configuration. For backend health
  only, it reads the installed `runtime.json` into guest process memory,
  validates the listener owners before sending its local authentication values,
  then discards those values without logging or evidencing them. It performs a
  final sensitive-pattern scan before hashing evidence.
- Post-install verification does not trust a merely nonempty patched archive.
  It hashes the installed patch inputs, reruns that installed patch pipeline in
  guest-private Temp against the exact verified vendor `app.asar` and the
  guest's own `runtime.json`, and requires the recomputed archive to match the
  installed archive byte for byte. Temporary patch output and logs are deleted.

The writable evidence mapping is deliberately narrow but is still a host write
surface. Inspect its files as untrusted test output. Closing Windows Sandbox
permanently discards everything else in that sandbox.

## Generate without launching

Use the checksum supplied by the independent artifact audit, not a value copied
from the sidecar during this command:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\New-WindowsSandboxAcceptanceHarness.ps1 `
  -InstallerPath 'C:\path\to\CodexBot-Setup-0.1.4-DEVELOPMENT-<build-id>.exe' `
  -ExpectedSha256 '<independently-reviewed-64-character-sha256>' `
  -ExpectedBrandedExecutableSha256 '<independently-reviewed-branded-exe-sha256>' `
  -OutputRoot "$env:TEMP\CodexBot-Sandbox-Acceptance\review-001" `
  -DryRun
```

Dry run validates and stages the artifact, emits both `.wsb` files, and reports
whether Sandbox can be proven ready. It never starts Sandbox. `OutputRoot` must
not already exist so results from separate runs cannot be mixed.

The output contains:

- `CodexBot-Acceptance-Interactive.wsb`
- `CodexBot-Acceptance-Silent.wsb`
- `artifact\` — exact installer and sidecar only
- `harness\` — runner and generated artifact audit receipt only
- `evidence\interactive\` and `evidence\silent\` — initially empty

## Run one scenario

After reviewing the generated XML, either double-click one `.wsb` file or ask
the generator to launch exactly one scenario:

```powershell
# Regenerate into a new OutputRoot, replacing Interactive with Silent as needed.
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\New-WindowsSandboxAcceptanceHarness.ps1 `
  -InstallerPath 'C:\path\to\CodexBot-Setup-0.1.4-DEVELOPMENT-<build-id>.exe' `
  -ExpectedSha256 '<independently-reviewed-64-character-sha256>' `
  -ExpectedBrandedExecutableSha256 '<independently-reviewed-branded-exe-sha256>' `
  -OutputRoot "$env:TEMP\CodexBot-Sandbox-Acceptance\review-002" `
  -LaunchScenario Interactive
```

Launch fails closed unless both `WindowsSandbox.exe` and the enabled
`Containers-DisposableClientVM` feature can be proven. The script does not
install the feature or request elevation.

### Interactive

The runner first proves a clean baseline and artifact integrity, then opens the
normal installer. A human must:

1. choose **Download and install the pinned official Grok Bot 0.18.0 user app**;
2. review and handle any SmartScreen or permission decision;
3. finish Setup and leave **Launch Codex Bot** selected;
4. complete Codex sign-in in the app;
5. in Settings, start **Sign in to Cursor and enable vendor computer**, then
   complete the Cursor web sign-in; and
6. return to the harness console and press Enter after reviewing each connected
   state. Never paste credentials, authorization URLs, or codes into that
   console;
7. let the harness verify authenticated Codex availability, official mode and
   readiness, a decoded bounded PNG frame, and every product listener;
8. in chat, ask the bot to go directly to `https://x.com` using the address bar,
   personally decide any action approval, and confirm the visible destination
   is x.com rather than another site's search results;
9. click **Take control**, confirm the computer expands to a large app-level
   view, click **Release control**, and confirm the small preview returns; and
10. return to the console after each manual review. The harness repeats its
    authenticated health/frame checks after the live steps.

The navigation and takeover Enter prompts record only operator attestations.
They do not drive the UI or inspect, capture, or prove the contents of an
account credential. The backend record contains only booleans, counts, and
frame dimensions/byte count. It never contains names, email addresses, URLs,
screenshots, headers, local authentication values, or account identifiers.

### Silent

The runner uses:

```text
/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /BOOTSTRAPGROKBOT=1
```

It does not launch or authenticate the app. Success requires the separately
installed vendor tree to pass the exact pinned manifest/signature verifier. The
Codex Bot copy must contain every pinned vendor file, retain every pinned hash
except the intentionally patched `resources/app.asar`, and add exactly the one
branded `Codex Bot.exe`.

## Evidence review

Each completed scenario writes an allowlisted subset of:

- `artifact-audit.json`
- `baseline.json`
- `installer-sanitized.log`
- `post-install.json`
- `backend-verification.json` (interactive only)
- `manual-live-review.json` (interactive only)
- `backend-post-manual-review.json` (interactive only)
- `run-summary.json`
- `evidence-manifest.sha256`

Require `status: "passed"`, `cleanBaseline: true`, and
`postInstallVerified: true` in `run-summary.json`. Interactive evidence must
also have `backendHealthVerified`, `directNavigationReview`, and
`takeoverReview` set to `true`. Every field in both backend records must prove
success, while `operatorAuthenticationReview: "operator-attested"` and the
manual live-review booleans remain human evidence only. Review the live UI
before closing the sandbox. Preserve the evidence folder and record its
manifest hash with the release-candidate review.
