#!/bin/bash
# Run from a reviewed source checkout. Does not install system software or a daemon.
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
node_candidate="${NODE_BINARY:-node}"
# Match the service runtime so the app's signed native task-creation pipe works.
# Explicit --node / NODE_BINARY remains an operator override.
if [[ -z "${NODE_BINARY:-}" && -x /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node ]]; then
  node_candidate=/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node
fi
run_setup=1
config_option=""
from_option=""
from_path=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --node) [[ $# -ge 2 ]] || { echo 'Missing --node path' >&2; exit 2; }; node_candidate="$2"; shift 2 ;;
    --no-setup) run_setup=0; shift ;;
    --config) [[ $# -ge 2 ]] || { echo 'Missing --config path' >&2; exit 2; }; config_option="$2"; shift 2 ;;
    --from) [[ $# -ge 2 ]] || { echo 'Missing --from path' >&2; exit 2; }; from_option="$2"; shift 2 ;;
    --help|-h) echo 'Usage: bash scripts/install.sh [--node /absolute/path/to/node] [--config PATH] [--from PRIVATE_JSON | --no-setup]'; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
command -v "$node_candidate" >/dev/null 2>&1 || { echo 'Install Node.js 24+ first, or pass --node /absolute/path/to/node.' >&2; exit 1; }
node_binary="$("$node_candidate" -p 'process.execPath')"
"$node_binary" -e 'if (Number(process.versions.node.split(".")[0]) < 24) { console.error("Node.js 24+ is required. Pass --node with your Node 24+ binary."); process.exit(1); }'
if [[ "$run_setup" -eq 0 && -n "$from_option" ]]; then echo '--from cannot be combined with --no-setup.' >&2; exit 2; fi
config_path="$("$node_binary" -e 'const p=require("node:path"); console.log(p.resolve(process.argv[1] || process.env.CODEX_IMESSAGE_CONFIG || p.join(require("node:os").homedir(),".config","codex-imessage","config.json")))' "$config_option")"
setup_args=(setup --config "$config_path")
connection_guidance() {
  local relay_enabled
  relay_enabled="$("$node_binary" --input-type=module -e 'import {pathToFileURL} from "node:url"; const {readConfig}=await import(pathToFileURL(process.argv[1]).href); console.log(readConfig(process.argv[2]).relay ? "yes" : "no");' "$repo_dir/dist/src/config.js" "$config_path")"
  if [[ "$relay_enabled" == yes ]]; then
    echo 'Belmivo outbound relay is configured. Reuse that enrollment; a Mac tunnel is not required for this route. Check actual delivery before changing any existing tunnel or webhook.'
  else
    echo 'For incoming messages, configure a matching provider webhook through scripts/tunnel.sh, or import an enrolled relay connection with the relay configure command. Account/device enrollment is separate.'
  fi
}
if [[ -n "$from_option" ]]; then
  from_path="$("$node_binary" -e 'console.log(require("node:path").resolve(process.argv[1]))' "$from_option")"
  setup_args+=(--from "$from_path")
fi
if [[ "$run_setup" -eq 1 && -f "$repo_dir/dist/src/cli.js" && -f "$config_path" ]]; then
  # Reuse/validate a working installation without replacing dependencies under its service.
  "$node_binary" "$repo_dir/dist/src/cli.js" "${setup_args[@]}"
  echo 'Reused the existing configuration and build. Running services were left in place.'
  connection_guidance
  exit 0
fi
if [[ "$(uname -s)" == Darwin ]] && launchctl print "gui/$(id -u)/com.codex-imessage.bridge" >/dev/null 2>&1; then
  echo 'The bridge LaunchAgent is loaded. Reuse the existing installation, or wait for idle and stop its service before rebuilding dependencies.' >&2
  exit 1
fi
# npm's CLI is executed with the selected Node, not whichever node happens to be on PATH.
npm_candidate="${NPM_CLI_PATH:-}"
# The app archive uses a shell wrapper at bin/npm; pass its actual JavaScript
# entry point to the selected Node. Standard Node layouts use this path too.
if [[ -z "$npm_candidate" && -f "$(dirname "$node_binary")/../lib/node_modules/npm/bin/npm-cli.js" ]]; then
  npm_candidate="$(dirname "$node_binary")/../lib/node_modules/npm/bin/npm-cli.js"
fi
if [[ -z "$npm_candidate" && -f "$(dirname "$node_binary")/npm" ]]; then
  npm_candidate="$(dirname "$node_binary")/npm"
fi
if [[ -z "$npm_candidate" ]]; then npm_candidate="$(command -v npm || true)"; fi
[[ -n "$npm_candidate" && -f "$npm_candidate" ]] || { echo 'npm is required. Set NPM_CLI_PATH to npm/bin/npm-cli.js if needed.' >&2; exit 1; }
npm_cli="$("$node_binary" -e 'console.log(require("node:fs").realpathSync(process.argv[1]))' "$npm_candidate")"
cd "$repo_dir"
# Source-only wrapper holds the receiver lock throughout both dependency replacement
# and compilation. It works before dist or node_modules exists.
build_pid=""
interrupt_build() {
  if [[ -n "$build_pid" ]]; then
    kill -s "$1" "$build_pid" 2>/dev/null || true
    wait "$build_pid" 2>/dev/null || true
  fi
  exit "$2"
}
trap 'interrupt_build INT 130' INT
trap 'interrupt_build TERM 143' TERM
"$node_binary" --experimental-strip-types "$repo_dir/scripts/build-source.mjs" "$config_path" "$npm_cli" "${from_path:-}" &
build_pid=$!
build_status=0
wait "$build_pid" || build_status=$?
build_pid=""
trap - INT TERM
[[ "$build_status" -eq 0 ]] || exit "$build_status"
printf 'Built source checkout at %s\nSelected runtime: %s\n' "$repo_dir" "$node_binary"
if [[ "$run_setup" -eq 1 ]]; then
  "$node_binary" "$repo_dir/dist/src/cli.js" "${setup_args[@]}"
  connection_guidance
else
  echo 'Setup skipped. Finish provider webhook registration, then run:'
  printf '%q %q setup --config %q\n' "$node_binary" "$repo_dir/dist/src/cli.js" "$config_path"
fi
