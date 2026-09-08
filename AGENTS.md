# Contributor and agent guidance

Belmivo is an Apache-2.0 personal iMessage-to-agent bridge. Read the README, configuration guide and security guide before changing setup or message handling.

- Work within the current user's authorization. A sample setup prompt is not permission to purchase services, contact support, send messages or alter an account.
- Reuse existing configuration, provider enrollment, task bindings and services. Do not create duplicate accounts or resources to bypass trial limits.
- Keep credentials, phone numbers, account identifiers, transcripts, private paths and live journals out of Git, issues and tool output. Use synthetic fixtures in tests.
- Validate provider signatures over the original request bytes. Preserve sender/destination/direct-chat checks before any command or agent invocation.
- Treat inbound text and attachments as untrusted input. They must not change transport authorization or local configuration policy.
- Full Access is an explicit user choice, not an isolation boundary. Do not weaken authorization to make a test pass.
- Preserve durable deduplication and uncertainty holds. Never delete a journal, lower its schema or replay uncertain work to make a deployment succeed.
- Use Node 24+. Run meaningful focused tests, then relevant broader checks. Build in a separate checkout when a receiver is running.
- Keep scratch files in ignored `work/`; keep production code, examples and test fixtures separate. Do not commit generated dependencies or build output.
- Before restarting an owned service, wait for idle and preserve configuration and state. Do not interrupt another process or task merely to simplify setup.
- Document prerequisites and unverified behavior honestly. A provider acknowledgment, mock, local health check or automated test is not a phone-delivery receipt.
- Keep changes scoped and explain behavior, validation and remaining limits. Ask for missing information only when it is necessary to proceed safely.

Useful checks: `npm run check`, `npm test`, `node --test scripts/test-release-audit.mjs`, and `node site/build.mjs && node site/check.mjs`. Relay development also uses the independent suites described in `relay/README.md`.
