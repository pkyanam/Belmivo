#!/bin/bash
# Opt-in user LaunchAgent. Never stores provider credentials in the plist.
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
action="${1:-help}"
[[ $# -eq 0 ]] || shift
label='com.codex-imessage.bridge'
plist_path="$HOME/Library/LaunchAgents/$label.plist"
config_path="${CODEX_IMESSAGE_CONFIG:-$HOME/.config/codex-imessage/config.json}"
node_candidate="${NODE_BINARY:-node}"
# The app's native task-creation pipe requires its signed runtime as the bridge parent.
# Explicit --node / NODE_BINARY remains an operator override.
if [[ -z "${NODE_BINARY:-}" && -x /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node ]]; then
  node_candidate=/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node
fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --node) [[ $# -ge 2 ]] || { echo 'Missing --node path' >&2; exit 2; }; node_candidate="$2"; shift 2 ;;
    --config) [[ $# -ge 2 ]] || { echo 'Missing --config path' >&2; exit 2; }; config_path="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [[ "$action" == help || "$action" == --help || "$action" == -h ]]; then
  echo 'Usage: bash scripts/launchd.sh install|uninstall|status [--node /absolute/path/to/node] [--config /absolute/path/to/config.json]'
  exit 0
fi
[[ "$(uname -s)" == Darwin ]] || { echo 'launchd requires macOS.' >&2; exit 1; }
service_target="gui/$(id -u)/$label"
assert_owned_plist() {
  [[ -f "$plist_path" && ! -L "$plist_path" && -O "$plist_path" ]] || { echo 'Refusing to replace or stop a LaunchAgent without its user-owned regular plist.' >&2; exit 1; }
  [[ "$(plutil -extract Label raw -o - "$plist_path")" == "$label" ]] || { echo 'LaunchAgent label does not match this bridge.' >&2; exit 1; }
  local installed_cli
  installed_cli="$(plutil -extract ProgramArguments.1 raw -o - "$plist_path")"
  # A renamed checkout may retain an owner-created compatibility symlink.
  # Accept only the exact path or the same existing file, never a different checkout.
  [[ "$installed_cli" == "$repo_dir/dist/src/cli.js" || "$installed_cli" -ef "$repo_dir/dist/src/cli.js" ]] || { echo 'LaunchAgent belongs to a different checkout. Use its owning installer to stop it.' >&2; exit 1; }
}
case "$action" in
  status) launchctl print "$service_target"; exit ;;
  uninstall)
    if [[ -e "$plist_path" || -L "$plist_path" ]] || launchctl print "$service_target" >/dev/null 2>&1; then
      assert_owned_plist
      bash "$repo_dir/scripts/launchd-bootout.sh" "$service_target"
      rm -f "$plist_path"
    fi
    echo 'LaunchAgent removed. Configuration, database, logs, and source checkout are retained.'
    exit ;;
  install) ;;
  *) echo "Unknown action: $action" >&2; exit 2 ;;
esac
command -v "$node_candidate" >/dev/null 2>&1 || { echo 'Node.js 24+ required; pass --node.' >&2; exit 1; }
node_binary="$("$node_candidate" -p 'process.execPath')"
"$node_binary" -e 'if (Number(process.versions.node.split(".")[0]) < 24) { console.error("Node.js 24+ required; pass --node."); process.exit(1); }'
[[ -f "$repo_dir/dist/src/cli.js" ]] || { echo 'Run scripts/install.sh first.' >&2; exit 1; }
config_path="$("$node_binary" -e 'console.log(require("node:path").resolve(process.argv[1]))' "$config_path")"
if [[ -e "$plist_path" || -L "$plist_path" ]] || launchctl print "$service_target" >/dev/null 2>&1; then assert_owned_plist; fi
# doctor validates private file permissions and config without making a paid model call.
"$node_binary" "$repo_dir/dist/src/cli.js" doctor --config "$config_path"
umask 077
mkdir -p "$(dirname "$plist_path")"
staged_plist="$(mktemp "$plist_path.XXXXXXXX")"
cleanup_staged_plist() { [[ -z "${staged_plist:-}" ]] || rm -f "$staged_plist"; }
trap cleanup_staged_plist EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
"$node_binary" --input-type=module - "$staged_plist" "$node_binary" "$repo_dir" "$config_path" "$label" <<'NODE'
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
const [plist, node, repo, config, label] = process.argv.slice(2);
const logs = join(dirname(config), 'logs');
mkdirSync(dirname(plist), { recursive: true });
mkdirSync(logs, { recursive: true, mode: 0o700 });
chmodSync(logs, 0o700);
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const string = value => `<string>${xml(value)}</string>`;
const path = `${dirname(node)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
const document = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key>${string(label)}
<key>ProgramArguments</key><array>${[node, join(repo, 'dist/src/cli.js'), 'start', '--config', config].map(string).join('')}</array>
<key>WorkingDirectory</key>${string(repo)}
<key>EnvironmentVariables</key><dict><key>PATH</key>${string(path)}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>30</integer>
<key>ExitTimeOut</key><integer>30</integer>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key>${string(join(logs, 'bridge.stdout.log'))}
<key>StandardErrorPath</key>${string(join(logs, 'bridge.stderr.log'))}
</dict></plist>\n`;
writeFileSync(plist, document, { mode: 0o600 });
chmodSync(plist, 0o600);
NODE
plutil -lint "$staged_plist"
# Keep the current plist intact if removal fails or has not completed yet.
# The helper waits synchronously for this exact service; no detached stop helper remains.
bash "$repo_dir/scripts/launchd-bootout.sh" "$service_target"
mv -f "$staged_plist" "$plist_path"
staged_plist=""
launchctl bootstrap "gui/$(id -u)" "$plist_path"
printf 'Installed %s\nUse scripts/launchd.sh status to inspect it. Keep the configured relay connected or the HTTPS tunnel running.\n' "$plist_path"
