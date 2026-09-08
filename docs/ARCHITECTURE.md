# Architecture

[Configuration](CONFIGURATION.md) · [Security](SECURITY.md)

```text
Approved phone → iMessage provider → authenticated webhook
                                               ↓
Phone ← provider reply ← durable journal ← agent on your Mac
```

A named HTTPS tunnel forwards the webhook to the loopback receiver. Alternatively, a self-operated relay accepts provider events and delivers them over the Mac's authenticated outbound connection. Only one selected route is needed for a new installation.

The receiver authenticates the provider and checks sender, destination and direct-chat evidence. Valid events are durably admitted before acknowledgment. Duplicate identifiers are checked against saved content; conflicting content fails closed.

The journal maps the phone conversation to permitted tasks and serializes work. The desktop backend connects to a dedicated task through private IPC. The app-server backend owns a separate Codex process. Their tool sets differ.

Replies pass through provider adapters; attachment return is restricted to configured artifact paths. Acceptance and uncertain delivery are recorded separately. A failed connection cannot safely be treated as proof that an external action did not happen.

Task creation, switching, status and cancellation use the same authenticated conversation scope. Confirmed cancellation retains an audit record; unresolved outcomes hold that conversation for review. Restart recovery reuses durable state and does not blindly resubmit unfinished effects.

This is a personal self-hosting architecture. Task isolation, filesystem isolation and remote service policy are separate concerns. Full Access remains the local user's privilege boundary.
