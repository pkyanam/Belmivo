# Operations and troubleshooting

[Setup](CONFIGURATION.md) · [Security](SECURITY.md)

Run commands from the checkout with your selected Node 24+ runtime. Ordinary checks do not need another model turn or a service restart.

## Connect and verify

For a new installation, open the configured desktop task, then run:

```bash
node dist/src/cli.js doctor
node dist/src/cli.js start
```

In another terminal:

```bash
curl --fail http://127.0.0.1:8787/healthz
node dist/src/cli.js status
```

Use the configured port if different. Health `ok` means the receiver is alive; cached backend connection counts do not prove phone delivery. Send one authorized request from your phone, verify its reply, and check a follow-up in the same conversation. Test needed attachments separately. Do not run a second receiver against an existing working installation.

`doctor --live` and `ask --text 'Reply with a short greeting.'` invoke the agent and consume its allowance; they do not send iMessage. Use them only for a needed diagnostic before startup or after stopping the owned idle receiver. Never bypass the worker lock with another data directory.

## Phone commands

| Text | Behavior |
| --- | --- |
| `/new [title]` | Create another desktop task for this conversation. |
| `/threads` | List recorded tasks. |
| `/switch 1` | Select a listed task. |
| `/status` | Show work, queue and holds. |
| `/cancel` | Request a stop and wait for its outcome. |
| `/help` | Show the command guide. |

Use `//help` to send a literal `/help` request. Commands have the same sender checks as normal messages. Creating a desktop task uses an additional agent turn. Uncertain creation is held rather than retried.

Cancellation sends one acknowledgment after its outcome is known. A confirmed stop permits another request; completed changes remain and the canceled request is not replayed. A lost connection or ambiguous delivery can keep the conversation held. Queued work is not automatically deleted.

## Run at login

After a successful foreground exchange, wait for the queue and task to become idle. Stop only that owned foreground receiver gracefully and wait for it to exit. Then:

```bash
bash scripts/launchd.sh install --node /absolute/path/to/node
bash scripts/launchd.sh status
```

The LaunchAgent records absolute runtime and checkout paths. Keep them in place. It starts after user login and restarts after unexpected failure; it does not run before login or wake the Mac. Provider secrets remain in private configuration. The legacy `com.codex-imessage.bridge` label and configuration paths remain compatible.

Logs live beside the configuration. The adjacent SQLite journal contains message text, responses and conversation identifiers. Keep both private. Automated log rotation and data retention are not implemented.

```bash
node dist/src/cli.js storage
```

This bounded read-only scan reports approximate journal, inbound-download and bridge-log bytes without opening the database or invoking the agent. Partial totals are marked as lower bounds. It does not cover generated workspace files, backups or tunnel logs, and never deletes anything.

## Recovery and troubleshooting

- **Old Node:** pass the correct absolute runtime to installer and launchd. Installing with one Node does not change your shell default.
- **Webhook 401:** check provider signature rules, signing secret, raw-body preservation and clock. Do not disable authentication.
- **Ignored messages:** verify direction, sender, destination and direct-chat evidence. Keep payload diagnostics private.
- **No reply:** inspect `doctor`, `status`, health, provider entitlement and the selected relay/tunnel.
- **Desktop unavailable:** open the configured task and verify its ID and Full Access. An IPC mismatch needs a compatible adapter; the separate app-server fallback is not tool-equivalent.
- **A PDF arrives as `.icns`:** attach the actual document from Finder or Files rather than a copied file icon, and check the attachment preview.
- **Uncertain work:** inspect the task and provider record before choosing a resolution. Do not delete the journal or retry the request blindly.

```bash
node dist/src/cli.js review
node dist/src/cli.js resolve --job ID --action abandon --reviewed
```

Use `--action delivered` only when you have confirmed delivery. Resolution records an inspected disposition; it does not replay work or send another message.

## Upgrade and uninstall

Use a separate source checkout for validation. Before replacing a live build, wait for idle, stop the owned receiver, preserve config and a consistent SQLite backup, then install a compatible build. Older binaries reject newer schemas. Never lower a schema version or restore old state casually: an old journal may omit effects that already occurred.

```bash
bash scripts/launchd.sh uninstall
bash scripts/tunnel.sh uninstall
```

Each command stops/removes its own LaunchAgent. Configuration, journals, logs, source, sign-in and tunnel credentials remain. The tunnel's remote resource and DNS route also remain until deliberately removed. Manage provider subscriptions in the provider account.

## Development

```bash
npm ci --ignore-scripts
npm run check
npm test
node site/build.mjs
node site/check.mjs
```

Use Node 24+ and avoid rebuilding under a receiver. `src/` contains runtime code, `test/` contracts and integration tests, `scripts/` installation helpers, and `examples/` placeholders. Use ignored `work/` for scratch data. Follow [contributor guidance](../AGENTS.md) and the [release procedure](RELEASE.md).
