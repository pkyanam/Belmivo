# Release procedure

The supported release is the personal self-hosted source distribution. A release does not provision provider accounts or certify every Mac/app version.

## Validate

Use Node 24+ in a separate checkout, never under a running receiver:

```bash
npm ci --ignore-scripts
npm run check
npm test
node --test scripts/test-release-audit.mjs
node site/build.mjs
node site/check.mjs
```

Run the relay's independent suites when its files change. Verify the exact candidate commit's CI and inspect the supported setup flow. Automated fixtures do not replace the user's own phone exchange.

## Audit and package

Keep credentials, messages, personal identifiers and live journals out of source and release notes. The generic source audit runs without private configuration:

```bash
node scripts/audit-release.mjs --patterns-only
```

Before distribution, also perform an exact-value review against private local configuration when available. Do not upload that configuration or matched values. Review license/NOTICE, dependency licenses and the authoritative `npm-shrinkwrap.json`; do not add a second root lockfile.

Pin one reviewed commit. Export exact regular Git blobs and executable modes without development history, `.git`, dependencies, build output, private state or scratch files. Normalize archive ownership/timestamps, record SHA-256, and verify extracted bytes and links. Record what was tested and the remaining limitations.

Create a versioned release without moving conflicting tags or overwriting historical assets. Verify uploaded bytes before publishing. An uncertain API response requires inspection before retrying; never assume it performed no action. Website and npm publication are separate explicit steps. There is no supported npm package installation path in this release.

## Upgrade existing installations

Wait for idle and stop only the owned receiver. Preserve private configuration and a consistent journal backup, then use a compatible build. Do not lower schema versions, discard holds or restore stale state to bypass recovery. See [operations](OPERATIONS.md#upgrade-and-uninstall).
