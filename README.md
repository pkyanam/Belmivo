# Belmivo

**Text your Mac's AI agent. Get the reply in iMessage.**

Belmivo is a self-hosted bridge between an approved iMessage sender and Codex on your Mac. It receives authenticated provider webhooks, runs work in a dedicated task, and sends the response back to the same conversation.

Apache-2.0 licensed. You operate the bridge and bring your own provider account and agent access.

## Get started

You need macOS, Codex installed and signed in, Node **24+** with npm, and an iMessage provider account that supports both incoming webhooks and replies. Keep the Mac awake, online and logged in. The installer can discover the app-bundled Node/npm runtime.

```bash
git clone --branch v0.1.0 https://github.com/pkyanam/Belmivo.git
cd Belmivo
bash scripts/install.sh --no-setup
```

The installer builds from locked dependencies and prints the exact setup command for your selected runtime. It does not create an account, provision a number or start a service.

1. Create or reuse a provider project and verify your phone as its approved sender. Photon shared evaluation is supported when your account has the required entitlement; availability and limits are determined by the provider.
2. Set up a [named HTTPS tunnel](docs/CONFIGURATION.md#named-cloudflare-tunnel) or import an [enrolled outbound relay](docs/CONFIGURATION.md#outbound-relay).
3. Register the webhook, save its signing secret privately, then run the installer's printed setup command. Select a dedicated Full Access task in the desktop app.
4. [Verify a foreground exchange](docs/OPERATIONS.md#connect-and-verify), then install the [login service](docs/OPERATIONS.md#run-at-login) while idle.

[Complete setup guide](docs/CONFIGURATION.md) · [Let your agent help](docs/AGENT-SETUP-PROMPT.md) · [Documentation site](https://pkyanam.github.io/Belmivo/)

## What you can do

Send a request, continue a conversation, or attach a supported file. Generated files can be returned when the agent links them from the configured artifact directory. Attachment support depends on the provider and backend; test the formats you need.

| Command | Action |
| --- | --- |
| `/new [title]` | Create a new desktop task. |
| `/threads` | List this conversation's tasks. |
| `/switch 1` | Continue a listed task. |
| `/status` | Show work, queue and review holds. |
| `/cancel` | Request a stop and wait for confirmation. |
| `/help` | Show the command guide. |

The local SQLite journal preserves task mapping and deduplication across restarts. Unknown execution or delivery outcomes are held for review, rather than automatically replayed. Cancellation keeps completed changes; it does not undo external actions.

## Security and limits

Provider authentication, the sender allowlist, destination checks and direct-chat checks run before task admission. Group chats are rejected. Full Access gives the agent the Mac user's available tools and files; the allowlist does **not** sandbox that agent. Provider and relay infrastructure can process message content. See [security boundaries](docs/SECURITY.md).

Desktop integration uses private, version-sensitive IPC. Keep the app running and open the configured task if it has unloaded. Sleep/wake recovery, every app update, every media format and fresh-machine compatibility need validation on your installation. The separate `app-server` backend has a different tool set; neither backend promises ChatGPT saved-memory parity.

This release is for personal self-hosting. It does not provide a managed signup service or automatic provider provisioning. Do not expose desktop IPC or app-server ports to the internet.

## Documentation and development

- [Configuration](docs/CONFIGURATION.md): prerequisites, provider settings and connection bootstrap.
- [Operations](docs/OPERATIONS.md): checks, commands, recovery, upgrades and uninstall.
- [Architecture](docs/ARCHITECTURE.md): message flow and durable state.
- [Security](docs/SECURITY.md): authentication, local privileges and reporting.
- [Release notes](docs/releases/v0.1.0.md) · [Release procedure](docs/RELEASE.md) · [Contributing rules](AGENTS.md).

Use Node 24+ in a separate checkout for development:

```bash
npm ci --ignore-scripts
npm run check
npm test
```

Do not replace dependencies or builds underneath a running receiver. The legacy `codex-imessage` CLI alias, configuration directory and service labels remain for compatibility.
