#!/usr/bin/env bash

set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly LABEL="com.playbypoint.booking"
readonly TEMPLATE="${SCRIPT_DIR}/launchd/${LABEL}.plist.template"
readonly LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
readonly INSTALLED_PLIST="${LAUNCH_AGENTS_DIR}/${LABEL}.plist"
readonly DOMAIN="gui/$(id -u)"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
  rm -f "$INSTALLED_PLIST"
  printf 'Removed %s\n' "$INSTALLED_PLIST"
  exit 0
fi

[[ $# -eq 0 ]] || {
  printf 'Usage: %s [--uninstall]\n' "$0" >&2
  exit 2
}

[[ -f "$TEMPLATE" ]] || {
  printf 'LaunchAgent template not found: %s\n' "$TEMPLATE" >&2
  exit 1
}
[[ -f "${SCRIPT_DIR}/playbypoint-credentials.local.sh" ]] || {
  printf 'Credentials file not found: %s\n' "${SCRIPT_DIR}/playbypoint-credentials.local.sh" >&2
  exit 1
}

mkdir -p "$LAUNCH_AGENTS_DIR" "${PROJECT_DIR}/logs"
escaped_project="${PROJECT_DIR//&/\\&}"
escaped_home="${HOME//&/\\&}"
sed \
  -e "s|__PROJECT_DIR__|${escaped_project}|g" \
  -e "s|__USER_HOME__|${escaped_home}|g" \
  "$TEMPLATE" >"$INSTALLED_PLIST"

plutil -lint "$INSTALLED_PLIST"
launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$INSTALLED_PLIST"
launchctl enable "${DOMAIN}/${LABEL}"

printf 'Installed and enabled %s\n' "$INSTALLED_PLIST"
printf 'Schedule: every day at 6:56 AM in the Mac system time zone.\n'
printf 'Run a manual scheduler test with:\n  launchctl kickstart -k %s/%s\n' "$DOMAIN" "$LABEL"
printf 'Logs:\n  %s/logs/playbypoint-launchd.stdout.log\n  %s/logs/playbypoint-launchd.stderr.log\n' \
  "$PROJECT_DIR" "$PROJECT_DIR"
