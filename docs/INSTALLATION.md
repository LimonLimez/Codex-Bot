# Installation

## Interactive setup

1. Download the installer and its `.sha256` sidecar from the same GitHub release.
2. Verify the hash, then run Setup as the Windows user who will use Open Bot.
3. Choose whether to reuse an exact Grok Bot 0.18.0 installation or authorize the separate vendor-hosted download. Setup does not download it by default.
4. Setup verifies the complete vendor tree, copies it, applies the reviewed patch, verifies the result, and installs the local bridge.
5. Launch Open Bot and connect a provider.

The separately downloaded vendor installer is pinned by URL, size, SHA-256, version, product identity, and Authenticode signer. Open Bot releases never embed or mirror it.

## Silent setup

Silent dependency download remains explicit:

```powershell
OpenBot-Setup-0.1.10.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /BOOTSTRAPGROKBOT=1
```

Without `/BOOTSTRAPGROKBOT=1`, silent setup requires an already verified compatible tree and fails closed if none exists.

## Upgrades and uninstall

Close Open Bot before upgrading. Setup preserves per-user conversations, provider configuration, schedules, and browser profiles. Uninstall can remove the application while leaving user data for a later reinstall. For a genuinely fresh test, remove the retained Open Bot state separately; do not delete an unrelated Grok Bot or Cursor profile.

The vendor application installed during bootstrap is separate. If its installer completes but Open Bot setup later fails or is cancelled, that separate vendor installation can remain and must be uninstalled independently.

## Build from source

Requirements: Windows 10/11 x64, Node.js/npm, Inno Setup 6, and the exact supported vendor tree.

```powershell
npm ci
npm run check
npm test
npm run audit:release
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-installer.ps1
```

Dirty worktrees produce uniquely named **DEVELOPMENT TEST BUILD — DO NOT PUBLISH** artifacts only. Canonical release builds require a clean, committed tree.
