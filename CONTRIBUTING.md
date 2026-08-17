# Contributing

Thanks for helping make Open Bot safer, clearer, and more useful.

## Development workflow

1. Create a focused branch from `main`.
2. Install the locked dependency graph with `npm ci`.
3. Keep patches small and add regression coverage for behavior changes.
4. Run the complete local gate:

```powershell
npm run check
npm test
npm run audit:release
npm audit --omit=dev
```

5. Open a pull request that explains the user-visible result, security impact, and verification performed.

## Safety rules

Do not commit vendor applications, extracted frontend bundles, patched archives, executable releases, OAuth files, API keys, service-account JSON, browser profiles, logs, databases, screenshots, personal paths, or generated macOS metadata. Patches must be reviewable transformations against the documented supported hash.

New listeners must remain loopback-only and authenticated. Changes that expand side effects must preserve explicit approvals, takeover fencing, and fail-closed provider routing. Never add a fallback that silently sends a request to a different provider.

## Documentation

Update the relevant guide when changing installation, provider setup, architecture, privacy, permissions, or troubleshooting behavior. Prefer primary upstream documentation and record exact dependency pins in code or manifests, not prose alone.

## Pull-request checklist

- [ ] The change is scoped and has tests.
- [ ] No credentials, runtime data, vendor binaries, or personal artifacts are included.
- [ ] User-facing behavior and docs agree.
- [ ] Formatting, tests, security audit, and dependency audit pass.
- [ ] Release-facing changes fail closed on unexpected inputs.
