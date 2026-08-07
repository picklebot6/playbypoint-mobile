#!/usr/bin/env bash

set -Eeuo pipefail

# Playwright-style local session for Playbypoint:
# boot/reuse an Android emulator, run the Appium login automation, and leave the
# emulator open with its persisted application data.

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly LOGIN_SCRIPT="${SCRIPT_DIR}/playbypoint-login.sh"
readonly CREDENTIALS_FILE="${PLAYBYPOINT_CREDENTIALS_FILE:-${SCRIPT_DIR}/playbypoint-credentials.local.sh}"
readonly TARGET_ANDROID_PACKAGE="${ANDROID_PACKAGE:-com.playbypoint.appx}"
readonly BOOT_TIMEOUT="${BOOT_TIMEOUT:-180}"
readonly HEADLESS="${HEADLESS:-1}"

export APPIUM_HOME="${APPIUM_HOME:-${PROJECT_DIR}/.appium}"
export npm_config_cache="${npm_config_cache:-${PROJECT_DIR}/.npm-cache}"
if [[ -d "${PROJECT_DIR}/node_modules/.bin" ]]; then
  export PATH="${PROJECT_DIR}/node_modules/.bin:${PATH}"
fi

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

find_android_sdk() {
  if [[ -n "${ANDROID_SDK_ROOT:-}" ]]; then
    printf '%s' "$ANDROID_SDK_ROOT"
  elif [[ -n "${ANDROID_HOME:-}" ]]; then
    printf '%s' "$ANDROID_HOME"
  elif [[ -d "${HOME}/Library/Android/sdk" ]]; then
    printf '%s' "${HOME}/Library/Android/sdk"
  else
    return 1
  fi
}

find_tool() {
  local name="$1"
  local sdk_path="$2"
  local candidate=""

  if command -v "$name" >/dev/null 2>&1; then
    command -v "$name"
    return
  fi
  case "$name" in
    adb) candidate="${sdk_path}/platform-tools/adb" ;;
    emulator) candidate="${sdk_path}/emulator/emulator" ;;
  esac
  [[ -x "$candidate" ]] || return 1
  printf '%s' "$candidate"
}

wait_for_boot() {
  local adb_path="$1"
  local serial="$2"
  local deadline=$((SECONDS + BOOT_TIMEOUT))
  local state=""
  local boot_completed=""
  local ready_checks=0
  local attempts=0

  printf 'Waiting for Android emulator %s to be online and finish booting...\n' "$serial"
  while (( SECONDS < deadline )); do
    attempts=$((attempts + 1))
    state="$($adb_path -s "$serial" get-state 2>/dev/null || true)"
    boot_completed=""
    if [[ "$state" == "device" ]]; then
      boot_completed="$($adb_path -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
    fi

    if [[ "$state" == "device" && "$boot_completed" == "1" ]] && \
       "$adb_path" -s "$serial" shell true >/dev/null 2>&1; then
      ready_checks=$((ready_checks + 1))
      if (( ready_checks >= 3 )); then
        "$adb_path" -s "$serial" shell input keyevent 82 >/dev/null 2>&1 || true
        return 0
      fi
    else
      ready_checks=0
      if [[ "$state" == "offline" ]] && (( attempts % 5 == 0 )); then
        printf 'Emulator %s is offline; asking adb to reconnect...\n' "$serial"
        "$adb_path" reconnect offline >/dev/null 2>&1 || true
      fi
    fi
    sleep 2
  done
  return 1
}

main() {
  [[ "${1:-}" != "-h" && "${1:-}" != "--help" ]] || {
    cat <<'USAGE'
Usage:
  ./scripts/playbypoint-local-session.sh

The command boots or reuses a local Android emulator, opens Playbypoint, logs
in, and leaves the emulator running. App data is preserved between runs.

Options:
  AVD_NAME=<name>       Android Virtual Device to start; defaults to the first
  BOOT_TIMEOUT=<secs>   Emulator boot timeout (default: 180)
  UDID=<serial>         Reuse a specific running emulator
  HEADLESS=0|1          Start a new emulator with no window/audio (default: 0)

Credentials are loaded from scripts/playbypoint-credentials.local.sh. Set
PLAYBYPOINT_CREDENTIALS_FILE to use a different local shell configuration.
Set ADDITIONAL_PLAYER_NAME in that file to add a player after court selection.
USAGE
    exit 0
  }
  [[ $# -eq 0 ]] || die "Unexpected arguments; use --help"
  [[ "$HEADLESS" == "0" || "$HEADLESS" == "1" ]] || die "HEADLESS must be 0 or 1"
  [[ -x "$LOGIN_SCRIPT" ]] || die "Login script is missing or not executable: ${LOGIN_SCRIPT}"
  [[ -f "$CREDENTIALS_FILE" ]] || die "Credentials file not found: ${CREDENTIALS_FILE}"

  # shellcheck source=/dev/null
  source "$CREDENTIALS_FILE"
  [[ -n "${PLAYBYPOINT_EMAIL:-}" && "$PLAYBYPOINT_EMAIL" != 'replace-with-your-email@example.com' ]] || \
    die "Set PLAYBYPOINT_EMAIL in ${CREDENTIALS_FILE}"
  [[ -n "${PLAYBYPOINT_PASSWORD:-}" && "$PLAYBYPOINT_PASSWORD" != 'replace-with-your-password' ]] || \
    die "Set PLAYBYPOINT_PASSWORD in ${CREDENTIALS_FILE}"
  export PLAYBYPOINT_EMAIL PLAYBYPOINT_PASSWORD
  export ADDITIONAL_PLAYER_NAME="${ADDITIONAL_PLAYER_NAME:-}"

  local sdk_path adb_path emulator_path serial avd_name emulator_log emulator_pid package_path
  local -a emulator_args
  sdk_path="$(find_android_sdk || true)"
  adb_path="$(find_tool adb "$sdk_path")" || die "adb not found. Install Android SDK Platform-Tools."
  emulator_path="$(find_tool emulator "$sdk_path")" || die "Android emulator not found. Install it from Android Studio's SDK Manager."
  if [[ -z "$sdk_path" ]]; then
    sdk_path="$(cd "$(dirname "$adb_path")/.." && pwd)"
  fi
  export ANDROID_SDK_ROOT="$sdk_path"
  export ANDROID_HOME="$sdk_path"
  export PATH="${sdk_path}/platform-tools:${sdk_path}/emulator:${PATH}"

  serial="${UDID:-}"
  if [[ -z "$serial" ]]; then
    # Reuse an existing emulator even when adb temporarily reports it offline;
    # wait_for_boot handles reconnecting it instead of starting a duplicate AVD.
    serial="$($adb_path devices | awk '$1 ~ /^emulator-/ {print $1; exit}')"
  fi

  if [[ -z "$serial" ]]; then
    avd_name="${AVD_NAME:-}"
    if [[ -z "$avd_name" ]]; then
      avd_name="$($emulator_path -list-avds | sed -n '1p')"
    fi
    [[ -n "$avd_name" ]] || die "No Android Virtual Device exists. Create one with a Play Store image in Android Studio's Device Manager."

    mkdir -p "${PROJECT_DIR}/logs"
    emulator_log="${PROJECT_DIR}/logs/playbypoint-emulator.log"
    emulator_args=(-avd "$avd_name" -no-boot-anim)
    if [[ "$HEADLESS" == "1" ]]; then
      emulator_args+=(-no-window -no-audio)
      printf 'Starting Android emulator %s in headless mode (log: %s)...\n' "$avd_name" "$emulator_log"
    else
      printf 'Starting Android emulator %s with a visible window (log: %s)...\n' "$avd_name" "$emulator_log"
    fi
    "$emulator_path" "${emulator_args[@]}" >"$emulator_log" 2>&1 &
    emulator_pid=$!
    "$adb_path" start-server >/dev/null 2>&1 || true

    local deadline=$((SECONDS + BOOT_TIMEOUT))
    while (( SECONDS < deadline )); do
      serial="$($adb_path devices | awk '$1 ~ /^emulator-/ {print $1; exit}')"
      [[ -n "$serial" ]] && break
      if ! kill -0 "$emulator_pid" >/dev/null 2>&1; then
        printf 'Android emulator exited before appearing in adb. Recent log output:\n' >&2
        tail -n 30 "$emulator_log" >&2 || true
        die "Android emulator process terminated; inspect ${emulator_log}"
      fi
      sleep 1
    done
    [[ -n "$serial" ]] || die "Emulator did not appear in adb within ${BOOT_TIMEOUT}s; inspect ${emulator_log}"
  elif [[ "$HEADLESS" == "1" ]]; then
    printf 'Reusing existing emulator %s; HEADLESS only applies when starting a new emulator.\n' "$serial"
  fi

  wait_for_boot "$adb_path" "$serial" || die "Emulator did not finish booting within ${BOOT_TIMEOUT}s"
  package_path="$($adb_path -s "$serial" shell pm path "$TARGET_ANDROID_PACKAGE" 2>/dev/null | tr -d '\r')"
  if [[ "$package_path" != package:* ]]; then
    die "Playbypoint is not installed on ${serial}. Open Google Play in the emulator, install Playbypoint, then rerun this command."
  fi

  printf 'Launching local Playbypoint session on %s...\n' "$serial"
  PLATFORM=android \
  UDID="$serial" \
  ANDROID_PACKAGE="$TARGET_ANDROID_PACKAGE" \
  KEEP_SESSION=0 \
    "$LOGIN_SCRIPT"

  printf '\nThe emulator remains open and its Playbypoint login state is persisted.\n'
  printf 'Run this command again to reuse the same local profile.\n'
}

main "$@"
