#!/usr/bin/env bash

set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# The LaunchAgent runs without an interactive shell, so provide the common
# Homebrew locations used by Intel and Apple Silicon Macs.
export PATH="${PROJECT_DIR}/node_modules/.bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export TZ="America/Los_Angeles"

mkdir -p "${PROJECT_DIR}/logs"
printf 'Scheduled PlayByPoint run started at %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')"

# HEADLESS=1 only changes an emulator started by this run. If an emulator is
# already running, the local-session script intentionally reuses it as-is.
HEADLESS=1 /usr/bin/caffeinate -i "${SCRIPT_DIR}/playbypoint-local-session.sh"

printf 'Scheduled PlayByPoint run finished at %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')"
