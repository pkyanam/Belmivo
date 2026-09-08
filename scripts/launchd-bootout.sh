#!/bin/bash
# Called only after the owning installer has validated its private LaunchAgent plist.
# launchctl bootout acknowledges asynchronously; bootstrap must await actual removal.
set -euo pipefail
service_target="${1:-}"
case "$service_target" in
  "gui/$(id -u)/com.codex-imessage.bridge"|"gui/$(id -u)/com.codex-imessage.tunnel") ;;
  *) echo 'Refusing to remove an unrelated launchd service.' >&2; exit 2 ;;
esac
if ! launchctl print "$service_target" >/dev/null 2>&1; then exit 0; fi
if ! launchctl bootout "$service_target" >/dev/null 2>&1; then
  echo 'launchctl did not confirm removal. No replacement service was started.' >&2
  exit 1
fi
# Poll only the exact service whose bootout succeeded, at most ten seconds.
for ((attempt=0; attempt<40; attempt++)); do
  if ! launchctl print "$service_target" >/dev/null 2>&1; then exit 0; fi
  sleep 0.25
done
echo 'The LaunchAgent is still unloading after ten seconds. Wait and inspect its status before retrying; no replacement was started.' >&2
exit 1
