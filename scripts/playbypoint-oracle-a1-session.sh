#!/usr/bin/env bash

set -Eeuo pipefail

# Oracle Ampere A1 launcher. ReDroid provides an ARM64 Android container because
# Google's desktop Android Emulator is not a suitable Linux/aarch64 runtime.

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly LOGIN_SCRIPT="${SCRIPT_DIR}/playbypoint-login.sh"
readonly CREDENTIALS_FILE="${PLAYBYPOINT_CREDENTIALS_FILE:-${SCRIPT_DIR}/playbypoint-credentials.local.sh}"
readonly TARGET_ANDROID_PACKAGE="${ANDROID_PACKAGE:-com.playbypoint.appx}"
readonly REDROID_CONTAINER_NAME="${REDROID_CONTAINER_NAME:-playbypoint-android}"
readonly REDROID_IMAGE="${REDROID_IMAGE:-redroid/redroid:14.0.0_64only-latest}"
readonly REDROID_DATA_DIR="${REDROID_DATA_DIR:-${PROJECT_DIR}/.redroid-data}"
readonly REDROID_ADB_SERIAL="${REDROID_ADB_SERIAL:-127.0.0.1:5555}"
readonly BOOT_TIMEOUT="${BOOT_TIMEOUT:-240}"

export APPIUM_HOME="${APPIUM_HOME:-${PROJECT_DIR}/.appium}"
export npm_config_cache="${npm_config_cache:-${PROJECT_DIR}/.npm-cache}"

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

find_adb() {
  local candidate
  if command -v adb >/dev/null 2>&1; then
    command -v adb
    return
  fi
  for candidate in \
    "${ANDROID_SDK_ROOT:-}/platform-tools/adb" \
    "${ANDROID_HOME:-}/platform-tools/adb" \
    "${HOME}/Android/Sdk/platform-tools/adb" \
    "${HOME}/android-sdk/platform-tools/adb" \
    /opt/android-sdk/platform-tools/adb; do
    [[ -x "$candidate" ]] && { printf '%s' "$candidate"; return; }
  done
  return 1
}

configure_linux_runtime() {
  local adb_path="$1"
  local sdk_path
  sdk_path="$(cd "$(dirname "$adb_path")/.." && pwd)"
  export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$sdk_path}"
  export ANDROID_HOME="${ANDROID_HOME:-$ANDROID_SDK_ROOT}"
  export PATH="${PROJECT_DIR}/node_modules/.bin:${ANDROID_SDK_ROOT}/platform-tools:${PATH}"

  if [[ -z "${JAVA_HOME:-}" ]] && command -v java >/dev/null 2>&1; then
    export JAVA_HOME
    JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")"
  fi
}

wait_for_android() {
  local adb_path="$1"
  local deadline=$((SECONDS + BOOT_TIMEOUT))
  local state boot_completed

  printf 'Waiting for ReDroid at %s to finish booting...\n' "$REDROID_ADB_SERIAL"
  while (( SECONDS < deadline )); do
    "$adb_path" connect "$REDROID_ADB_SERIAL" >/dev/null 2>&1 || true
    state="$($adb_path -s "$REDROID_ADB_SERIAL" get-state 2>/dev/null || true)"
    boot_completed=""
    if [[ "$state" == device ]]; then
      boot_completed="$($adb_path -s "$REDROID_ADB_SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
    fi
    if [[ "$state" == device && "$boot_completed" == 1 ]] && \
       "$adb_path" -s "$REDROID_ADB_SERIAL" shell true >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

start_redroid() {
  local running
  running="$(docker inspect -f '{{.State.Running}}' "$REDROID_CONTAINER_NAME" 2>/dev/null || true)"
  if [[ "$running" == true ]]; then
    printf 'Reusing ReDroid container %s.\n' "$REDROID_CONTAINER_NAME"
    return
  fi
  if docker inspect "$REDROID_CONTAINER_NAME" >/dev/null 2>&1; then
    printf 'Starting existing ReDroid container %s...\n' "$REDROID_CONTAINER_NAME"
    docker start "$REDROID_CONTAINER_NAME" >/dev/null
    return
  fi

  mkdir -p "$REDROID_DATA_DIR"
  printf 'Creating persistent ARM64 ReDroid container %s...\n' "$REDROID_CONTAINER_NAME"
  docker run -d \
    --name "$REDROID_CONTAINER_NAME" \
    --privileged \
    --restart unless-stopped \
    -v "${REDROID_DATA_DIR}:/data" \
    -p "127.0.0.1:5555:5555" \
    "$REDROID_IMAGE" \
    androidboot.redroid_width=1080 \
    androidboot.redroid_height=2400 \
    androidboot.redroid_dpi=420 \
    androidboot.redroid_gpu_mode=guest \
    androidboot.use_memfd=true >/dev/null
}

install_playbypoint_if_needed() {
  local adb_path="$1"
  local package_path
  package_path="$($adb_path -s "$REDROID_ADB_SERIAL" shell pm path "$TARGET_ANDROID_PACKAGE" 2>/dev/null | tr -d '\r' || true)"
  [[ "$package_path" == package:* ]] && return

  [[ -n "${PLAYBYPOINT_APK:-}" ]] || die \
    "Playbypoint is not installed. Set PLAYBYPOINT_APK to an APK file or a directory containing its split APKs."
  if [[ -d "$PLAYBYPOINT_APK" ]]; then
    local -a apk_files=()
    while IFS= read -r -d '' apk; do
      apk_files+=("$apk")
    done < <(find "$PLAYBYPOINT_APK" -maxdepth 1 -type f -name '*.apk' -print0)
    ((${#apk_files[@]} > 0)) || die "No APK files found in ${PLAYBYPOINT_APK}"
    printf 'Installing Playbypoint from %s split APK file(s)...\n' "${#apk_files[@]}"
    "$adb_path" -s "$REDROID_ADB_SERIAL" install-multiple -r "${apk_files[@]}"
  elif [[ -f "$PLAYBYPOINT_APK" ]]; then
    printf 'Installing Playbypoint APK...\n'
    "$adb_path" -s "$REDROID_ADB_SERIAL" install -r "$PLAYBYPOINT_APK"
  else
    die "PLAYBYPOINT_APK does not exist: ${PLAYBYPOINT_APK}"
  fi
}

main() {
  [[ "$(uname -s)" == Linux ]] || die "This launcher requires Linux"
  case "$(uname -m)" in
    aarch64|arm64) ;;
    *) die "This launcher is for Oracle Ampere A1 (ARM64); detected $(uname -m)" ;;
  esac
  command -v docker >/dev/null 2>&1 || die "Docker is required"
  docker info >/dev/null 2>&1 || die "Docker is unavailable; add this user to the docker group and start Docker"
  command -v node >/dev/null 2>&1 || die "Install ARM64 Node.js 22 or newer"
  command -v java >/dev/null 2>&1 || die "Install an ARM64 JDK (Java 17 or newer)"
  [[ -x "$LOGIN_SCRIPT" ]] || die "Missing login script: ${LOGIN_SCRIPT}"
  [[ -x "${PROJECT_DIR}/node_modules/.bin/appium" ]] || die "Run npm ci in ${PROJECT_DIR} first"
  [[ -d "${APPIUM_HOME}/node_modules/appium-uiautomator2-driver" ]] || die \
    "Install UiAutomator2 first: APPIUM_HOME=${APPIUM_HOME} npx appium driver install uiautomator2"
  [[ -f "$CREDENTIALS_FILE" ]] || die "Credentials file not found: ${CREDENTIALS_FILE}"

  local adb_path lock_file
  adb_path="$(find_adb || true)"
  [[ -n "$adb_path" ]] || die "adb is missing; install Android SDK Platform-Tools and set ANDROID_SDK_ROOT"
  configure_linux_runtime "$adb_path"

  lock_file="${PROJECT_DIR}/.playbypoint-oracle-a1.lock"
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$lock_file"
    flock -n 9 || die "Another Playbypoint run is already active"
  fi

  # shellcheck source=/dev/null
  source "$CREDENTIALS_FILE"
  [[ -n "${PLAYBYPOINT_EMAIL:-}" && -n "${PLAYBYPOINT_PASSWORD:-}" ]] || \
    die "Set PLAYBYPOINT_EMAIL and PLAYBYPOINT_PASSWORD in ${CREDENTIALS_FILE}"
  export PLAYBYPOINT_EMAIL PLAYBYPOINT_PASSWORD

  start_redroid
  if ! wait_for_android "$adb_path"; then
    docker logs --tail 40 "$REDROID_CONTAINER_NAME" >&2 || true
    die "ReDroid did not boot. Verify binder_linux support on the OCI kernel and inspect the container logs."
  fi
  install_playbypoint_if_needed "$adb_path"

  printf 'Launching Playbypoint automation on Oracle A1 ReDroid...\n'
  PLATFORM=android \
  UDID="$REDROID_ADB_SERIAL" \
  DEVICE_NAME='Oracle A1 ReDroid' \
  ANDROID_PACKAGE="$TARGET_ANDROID_PACKAGE" \
  KEEP_SESSION=0 \
    "$LOGIN_SCRIPT"
}

main "$@"
