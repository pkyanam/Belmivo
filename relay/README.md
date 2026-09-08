# Personal outbound relay

This Worker receives authenticated Photon events, durably queues them for one operator-owned Mac, and delivers them over a WebSocket initiated by the Mac. It hosts no Codex process. Configure a separate relay for each independent installation.

## Local verification

Requires Node 24+. From this directory:

```sh
npm ci
npm test
npx wrangler deploy --dry-run --outdir .wrangler/build
```

Tests use both pure policy/queue helpers and the actual local Cloudflare workerd runtime. No credentials or provider calls are required. Wrangler and Miniflare are pinned; the test adapter accommodates this pinned Miniflare version. The separate package is licensed under the repository's Apache-2.0 license.

The separate client/Worker integration suite requires macOS or Linux, Node 24+, `openssl`, and both sets of installed dependencies. From the repository root in a test checkout:

```sh
npm ci --ignore-scripts
npm --prefix relay ci --ignore-scripts
npm --prefix relay run test:integration
```

Dependency installation must not replace a running receiver's dependencies. The integration test itself compiles the root TypeScript project into a private temporary directory, leaving root `dist` untouched. It uses the actual compiled `RelayClient`, Photon parser, authorization policy, and SQLite `Store` against local Miniflare/workerd over verified HTTPS/WSS. Its generated one-day localhost certificate is trusted only by the fixture child through `NODE_EXTRA_CA_CERTS`; TLS verification is never disabled. Ports are assigned by the operating system.

The test holds local admission to prove no early ACK, checks the exact committed job through a separate read-only database connection before every ACK, drops one ACK, reopens the local store, and verifies duplicate suppression. It then restarts workerd with persisted state and checks queued delivery and ACK retention. A test-only Durable Object subclass supplies an internal storage barrier; production endpoints and ACK handling are unchanged. Automatic ping/pong is not used as evidence of ACK persistence.

The harness allows 30 seconds for compilation, 10 seconds for certificate creation, and 45 seconds for the fixture, with bounded process termination inside a 120-second test limit. Child output is capped at 64 KiB. It closes clients/stores/Miniflare and terminates only its own isolated process group on failure before removing temporary state. Existing `npm test` remains independent of root compilation. This is a synthetic client-to-admission durability test, not full Bridge execution, provider delivery, or a real Messages round trip; it makes no provider or agent calls.

## Operator configuration

Configure these five values as Worker secrets, never committed variables:

| Key | Value |
| --- | --- |
| `DEVICE_ID` | Random URL-safe identifier, 32–128 characters. |
| `DEVICE_TOKEN` | Independent random URL-safe secret, 32–128 characters. Generate at least 32 random bytes. |
| `PHOTON_WEBHOOK_SECRET` | The project's actual webhook signing secret, 16–512 characters. |
| `ALLOWED_SENDER` | The independently verified owner's E.164 phone number. |
| `SERVICE_NUMBER` | The configured provider line, or literal `shared` for the existing Photon shared evaluation. |

`wrangler secret put KEY` prompts privately. A deployment should use the intended Cloudflare account's Free Workers plan. Check account/plan before deploying; these files neither upgrade the account nor configure billing. The placeholder Worker name in `wrangler.jsonc` is not a provisioned service. `new_sqlite_classes` is deliberate: Free Durable Objects require SQLite storage. Logs and observability are disabled to avoid recording credential-bearing headers or message bodies.

Do not repoint a live provider webhook until the Worker has been reviewed, configured, deployed, and tested with an authenticated synthetic fixture. Keep the prior webhook URL privately for rollback. No deployment or provider change is performed by the test commands above.

## Protocol v1

Photon posts to (the exact compatibility path `/webhooks/photon` is also supported for an operator-owned Cloudflare Worker route, with the same authentication):

```text
POST https://<worker>/v1/webhooks/photon/<DEVICE_ID>
Content-Type: application/json
X-Spectrum-Timestamp: <original timestamp>
X-Spectrum-Signature: <original v0 HMAC>
```

The relay verifies raw bytes and the provider's five-minute timestamp window before admission. Request body reads have a ten-second deadline. It checks the configured sender, direct conversation, matching line, inbound direction and iMessage platform. Other event types, groups and unauthorized senders do not enter the queue. Duplicate event IDs with different raw bodies receive 409; queue/storage failures receive 503. An accepted or already remembered event returns 202. Authentication failures return 401.

The Mac connects outward:

```js
new WebSocket('wss://<worker>/v1/devices/<DEVICE_ID>/socket', [
  'codex-imessage-relay',
  'auth.' + deviceToken,
]);
```

Only `codex-imessage-relay` is echoed as the selected protocol. The token must never appear in URL parameters or application logs. Non-browser clients may instead use `Authorization: Bearer TOKEN` without subprotocols. Requests containing an `Origin` header are rejected. This is an application authentication interface, not a browser dashboard.

Server event:

```json
{
  "v": 1,
  "type": "event",
  "id": "<64 lowercase hex characters>",
  "eventId": "<original Photon message ID>",
  "receivedAt": 1800000000000,
  "expiresAt": 1800086400000,
  "headers": {
    "x-spectrum-timestamp": "1800000000",
    "x-spectrum-signature": "v0=<original signature>",
    "content-type": "application/json"
  },
  "bodyBase64": "<byte-exact original payload>"
}
```

Client acknowledgement:

```json
{"v":1,"type":"ack","id":"<same 64-character ID>"}
```

ACK only after the Mac has durably accepted the event into its local deduplicated store. If local policy permanently rejects an event, handle that deliberately rather than executing it or endlessly retrying; the protocol currently has no separate rejection frame. Socket closure or absence of ACK causes replay on reconnect with the original ID. The Mac's durable ledger prevents repeated execution; the relay itself does not guarantee exactly-once agent effects.

The client may send literal `ping` and receives `pong` through the hibernation auto-response API. Invalid frames close the connection. The server permits one current authenticated Mac connection; a new connection replaces the previous one. Keep reconnection backoff on the Mac. Disconnecting or rotating this device token does not constitute an authenticated phone re-pairing workflow.

## Trust and retention

After successful provider verification at ingress, the queue may retain an event for 24 hours. A later delivery's original provider timestamp may be expired. The Mac therefore needs a **separate, authenticated relay callback inside its process**, which parses and authorizes again and admits the durable event. Do not send stale events through the existing public webhook verifier, weaken that verifier's timestamp check, or expose an unauthenticated trusted-ingress HTTP endpoint.

The relay is a trusted transport: a compromised operator account or Worker can fabricate delivery envelopes. TLS protects transport, not against that operator. Provider payloads are stored in the operator's Cloudflare account; this is not end-to-end encrypted storage. No ChatGPT credentials, provider API execution secrets, local artifact paths or agent results are sent to this Worker. The personal Mac continues using its own Photon adapter for responses and media.

Hard limits: 256 KiB request bodies; 100 pending events; 8 MiB total pending envelope bytes; 2,000 remembered event IDs per 24-hour window; 20,000 text characters. Each event expires after 24 hours, including its ACK tombstone. Expiry alarms remove stored bodies and metadata. Pending queues can fill before the item limit because base64 expands bytes. No arbitrary URL proxy, file upload, remote shell, agent command endpoint, public enrollment or number purchase exists.
