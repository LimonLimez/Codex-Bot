# Contributing

Run `npm ci`, `npm run check`, `npm test`, and `npm run audit:release` before opening a pull request.

Do not commit vendor applications, extracted frontend bundles, patched archives, executable releases, OAuth files, API keys, browser profiles, logs, databases, screenshots, or personal paths. Patches must be expressed as small, reviewable transformations against the documented supported hash.

Changes that add network listeners must remain loopback-only and authenticated. Changes that expand automated side effects must preserve explicit user approval boundaries.
