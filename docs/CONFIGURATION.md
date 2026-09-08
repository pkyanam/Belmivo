# Configuration and setup

[Overview](../README.md) · [Operations](OPERATIONS.md) · [Security](SECURITY.md)

## Install from source

Requirements: macOS, Codex installed and signed in, Node 24+ with npm, and a provider account supporting incoming iMessage webhooks and outbound replies. A provider login alone does not establish that entitlement. Use legitimate free evaluation where available; verify account limits before relying on it.

```bash
git clone --branch v0.1.0 https://github.com/pkyanam/Belmivo.git
cd Belmivo
bash scripts/install.sh --no-setup
```

The installer discovers app-bundled Node/npm when available. To choose a runtime explicitly:

```bash
bash scripts/install.sh --node /absolute/path/to/node --no-setup
```

`NODE_BINARY` and `NPM_CLI_PATH` are also supported. The chosen Node executes npm, compilation and setup. The command installs the shrinkwrapped dependencies and builds the CLI, then prints the exact setup command. Keep that command: your ordinary shell's `node` may be older.

Build before registering the webhook. Complete setup after the provider returns its signing secret. The installer does not create provider accounts or start a background service. For an existing valid build/config, `bash scripts/install.sh` validates and reuses them. Do not rebuild while a receiver uses the checkout; a receiver with another configuration/data directory is outside the selected configuration's build lock.

## Provider settings

Photon uses `providerApiKey` for its project ID, `providerApiSecret` for the project secret, and `webhookSecret` for the webhook signing secret. For supported shared evaluation, configure `serviceNumber: "shared"` and `allowSharedSandbox: true`; do not invent an exclusively assigned number. Verify the account phone and add only your authorized sender to the provider project.

Other adapters include Linq, Sendblue and experimental Blooio. Their account entitlements and inbound schemas differ. Sendblue needs both API key and API secret. Blooio requires explicit direct-chat evidence and rejects messages when that evidence is absent. Consult the provider's current documentation; do not substitute an SMS-only number for iMessage support.

Keep all credentials in private local files or the setup questionnaire's hidden input. Do not place secrets in chat, screenshots, shell arguments or Git. Configuration is stored by default at `~/.config/codex-imessage/config.json` with owner-only permissions. The path remains for compatibility.

## Named Cloudflare Tunnel

For a new direct connection, install `cloudflared` and use a domain you control with DNS managed by Cloudflare. Authenticate the selected account:

```bash
cloudflared tunnel login
```

For the first installation, the final bridge config does not exist yet because it needs the webhook secret. Use a private provider/port-only input to establish the tunnel first:

```bash
bootstrap_dir="$(mktemp -d "${TMPDIR:-/tmp}/belmivo-tunnel.XXXXXX")"
(umask 077; printf '%s\n' '{"provider":"photon","port":8787}' > "$bootstrap_dir/tunnel-input.json")
bash scripts/tunnel.sh setup --name codex-imessage \
  --hostname imessage.YOUR_DOMAIN \
  --config "$bootstrap_dir/tunnel-input.json" \
  --tunnel-dir "$HOME/.config/codex-imessage/tunnel" \
  --node /absolute/path/to/node
```

Replace the hostname and Node path. This helper creates a tunnel and DNS route in the selected Cloudflare account and installs its user LaunchAgent. Register `https://imessage.YOUR_DOMAIN/webhooks/photon` with Photon, save the returned signing secret, then run the installer's printed setup command. Use the same provider and port in the final config. Remove the temporary input and its empty directory after success; the permanent tunnel does not depend on them.

With an existing complete config, the shorter setup command is:

```bash
bash scripts/tunnel.sh setup --name codex-imessage --hostname imessage.YOUR_DOMAIN
```

Use `--node`, `--config` and `--cloudflared` for explicit paths when needed. The helper refuses overwriting existing resources. If creation partly fails, inspect the account and retained files before retrying: the tunnel may already exist.

To reuse an already created locally managed tunnel and DNS route:

```bash
bash scripts/tunnel.sh prepare \
  --tunnel-id YOUR_TUNNEL_UUID \
  --credentials /absolute/path/to/YOUR_TUNNEL_UUID.json \
  --hostname imessage.YOUR_DOMAIN
bash scripts/tunnel.sh install
bash scripts/tunnel.sh status
```

`prepare` copies credentials privately and validates ingress; it does not create DNS or start the service. Keep customized `--config` and `--tunnel-dir` choices consistent. The named tunnel forwards only the configured `/webhooks/PROVIDER` route to loopback; public health and unrelated paths are blocked. Provider authentication still protects that route. Do not expose app-server or desktop IPC sockets.

For Linq, register `message.received`; Sendblue requires its incoming `receive` webhook with the correct secret. Follow provider-specific signing rules. A tunnel URL does not itself register a provider subscription.

[Cloudflare locally managed tunnel documentation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/)

## Outbound relay

An optional self-operated [relay](../relay/README.md) lets the Mac receive events through an authenticated outbound connection. It requires deploying/enrolling that relay separately; there is no built-in signup service. Reuse an existing enrollment when available.

After completing bridge setup, import an owner-only JSON file containing exactly `url`, `deviceId` and `token`:

```bash
node dist/src/cli.js relay configure --from /absolute/path/to/private-connection.json
node dist/src/cli.js doctor
```

The importer preserves other settings and does not restart the receiver or register a webhook. Identical imports are a no-op; replacing a different connection requires explicit `--replace`. No Mac tunnel is needed for this route. A relay ACK means durable local admission or rejection, not task completion or phone receipt.

## Complete private setup

Run the installer's printed command. To import complete settings from a private regular JSON file instead of the questionnaire:

```bash
node dist/src/cli.js setup --from /absolute/path/to/private-setup.json
```

Use your selected Node binary. `--config` selects the destination. Existing valid config is reused. The input must be owner-only; validation precedes publication. Remove temporary credential-bearing input when it is no longer needed. See the [desktop Photon example](../examples/desktop-photon.example.json) for field names and replace every placeholder.

For desktop mode, use `backend: "desktop"`, a pre-created dedicated `desktopThreadId`, exactly one `allowedSenders` entry, an existing working directory, an explicit `artifactsDir`, and `fullAccess: true`. Open that task in the app and ensure it is already in Full Access. Do not change unrelated app settings. The bridge requires autonomous execution; interactive approval-by-text is not implemented.

The desktop app must remain running. The bridge retains a bounded set of task connections, but cannot automatically open a task unloaded by an app restart. Desktop IPC is private and version-sensitive. The `app-server` fallback starts a separate Codex process and has a different tool set; desktop browser, Computer Use, plugins and saved-memory parity are not promised there.

## Attachments and reactions

Photon inbound downloads are limited to 20 MiB per file and 40 MiB per message. Generated files must be explicitly linked in the final response and be under `artifactsDir`; file type, size and path checks apply. Confirm needed formats on your own installation. An accepted send is not a delivery receipt.

`typingIndicators` defaults to `true`. Automatic status reactions default to `false`. `conversationalReactions` defaults to `true`, allowing at most one fitting native tapback chosen by the agent; disable it if unwanted. Other provider hooks may differ.

Environment overrides exist for `IMESSAGE_API_KEY`, `IMESSAGE_API_SECRET` and `IMESSAGE_WEBHOOK_SECRET`, but shell variables are not automatically inherited by launchd. Prefer the private config for persistent operation. Continue with [foreground verification](OPERATIONS.md#connect-and-verify).
