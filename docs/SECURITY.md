# Security boundaries

[Overview](../README.md) · [Operations](OPERATIONS.md)

## Who may submit work

Provider authentication is checked over the received webhook bytes. The configured sender allowlist, destination and direct-chat evidence are checked before commands or agent work. Group messages are rejected. Keep the allowlist narrow and do not weaken it to diagnose a routing problem.

The HTTP receiver binds to loopback. Expose only the provider webhook through the configured tunnel or use the authenticated outbound relay. Never expose desktop IPC or app-server ports. A public HTTPS URL alone does not authenticate a webhook.

## Local privileges and data

Full Access gives the agent the operating-system user's available tools, files and credentials. A dedicated task and working directory are organizational choices, not a sandbox. Do not run untrusted users' work under an OS account with operator or unrelated customer secrets.

Provider infrastructure, any configured relay, and the model provider may process message content. This bridge is not end-to-end encryption from iMessage through the model. Review those services' policies before sending sensitive information.

Private configuration stores provider credentials; the journal stores messages, replies and identifiers. Logs and downloaded/generated files may also be sensitive. Use owner-only permissions and secure backups. Do not post real config, payloads, transcripts or phone numbers in issues. Attachment path limits do not sandbox the agent's other tools.

## Durability and uncertainty

A durable journal tracks admission, execution, replies and cancellation. Unknown outcomes are held for inspection rather than automatically replayed. Cancellation does not undo completed effects. Local health or provider acceptance does not prove handset receipt.

Do not clear holds by deleting state, lowering the schema or restoring an old backup. A stale backup can omit an effect that already happened. Inspect and reconcile before recovery. Storage and logs can grow; diagnostics do not perform automatic deletion.

## Report a vulnerability

Do not publish exploit details or private data in an ordinary issue. Use GitHub's private vulnerability reporting option when it is enabled for the repository. Otherwise use a minimal public issue asking for a private reporting channel without including the vulnerability or sensitive material.

Include the affected version, a synthetic reproduction and the boundary involved. Never send working credentials as evidence.
