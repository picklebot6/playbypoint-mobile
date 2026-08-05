#!/usr/bin/env bash

set -Eeuo pipefail

# Log in to the installed Playbypoint mobile app through a local Appium 2 server.
# Credentials are deliberately read from the environment so they never need to
# be committed to source control.

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
export APPIUM_HOME="${APPIUM_HOME:-${PROJECT_DIR}/.appium}"
export npm_config_cache="${npm_config_cache:-${PROJECT_DIR}/.npm-cache}"
if [[ -z "${ANDROID_SDK_ROOT:-}" && -z "${ANDROID_HOME:-}" && -d "${HOME}/Library/Android/sdk" ]]; then
  export ANDROID_SDK_ROOT="${HOME}/Library/Android/sdk"
  export ANDROID_HOME="$ANDROID_SDK_ROOT"
fi
if [[ -n "${ANDROID_SDK_ROOT:-}" ]]; then
  export PATH="${ANDROID_SDK_ROOT}/platform-tools:${ANDROID_SDK_ROOT}/emulator:${PATH}"
elif [[ -n "${ANDROID_HOME:-}" ]]; then
  export PATH="${ANDROID_HOME}/platform-tools:${ANDROID_HOME}/emulator:${PATH}"
fi
if [[ -z "${JAVA_HOME:-}" ]]; then
  if [[ -x "${HOME}/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java" ]]; then
    export JAVA_HOME="${HOME}/Applications/Android Studio.app/Contents/jbr/Contents/Home"
  elif [[ -x "/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java" ]]; then
    export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
  elif [[ -x "/c/Program Files/Android/Android Studio/jbr/bin/java.exe" ]]; then
    export JAVA_HOME="/c/Program Files/Android/Android Studio/jbr"
  fi
fi
if [[ -n "${JAVA_HOME:-}" ]]; then
  export PATH="${JAVA_HOME}/bin:${PATH}"
fi
if [[ -d "${PROJECT_DIR}/node_modules/.bin" ]]; then
  export PATH="${PROJECT_DIR}/node_modules/.bin:${PATH}"
fi

readonly PLATFORM="${PLATFORM:-android}"
readonly APPIUM_SERVER_URL="${APPIUM_SERVER_URL:-http://127.0.0.1:4723}"
readonly DEVICE_NAME="${DEVICE_NAME:-Appium device}"
readonly ANDROID_PACKAGE="${ANDROID_PACKAGE:-com.playbypoint.appx}"
readonly IOS_BUNDLE_ID="${IOS_BUNDLE_ID:-}"
readonly ELEMENT_TIMEOUT="${ELEMENT_TIMEOUT:-25}"
readonly LOGIN_TIMEOUT="${LOGIN_TIMEOUT:-20}"
readonly LOGIN_PROMPT_TIMEOUT="${LOGIN_PROMPT_TIMEOUT:-12}"
readonly NOTIFICATION_PROMPT_TIMEOUT="${NOTIFICATION_PROMPT_TIMEOUT:-3}"
readonly BOOKING_TIMEOUT="${BOOKING_TIMEOUT:-20}"
readonly RUN_BOOKING_FLOW="${RUN_BOOKING_FLOW:-1}"

# Editable consecutive booking slots. Keep the labels exactly as displayed by
# Playbypoint; the booking flow selects each entry in this order.
BOOKING_TIME_SLOTS=(
  '6-6:30pm'
  '6:30-7pm'
  '7-7:30pm'
  '7:30-8pm'
)

# Editable court preference, from highest to lowest priority. The first court
# present on the availability screen is selected.
COURT_PRIORITY=(4 3 8 9 2 6 1 5 10 7)
readonly KEEP_SESSION="${KEEP_SESSION:-0}"
readonly START_APPIUM="${START_APPIUM:-1}"
readonly APPIUM_LOG="${APPIUM_LOG:-${TMPDIR:-/tmp}/playbypoint-appium.log}"

SESSION_ID=""
APPIUM_PID=""
PYTHON_BIN=""

usage() {
  cat <<'USAGE'
Usage:
  PLAYBYPOINT_EMAIL='player@example.com' \
  PLAYBYPOINT_PASSWORD='secret' \
  ./scripts/playbypoint-login.sh

Required:
  PLAYBYPOINT_EMAIL       Playbypoint account email
  PLAYBYPOINT_PASSWORD    Playbypoint account password

Common options:
  PLATFORM=android|ios    Mobile platform (default: android)
  UDID=<device-id>        Device/emulator UDID (recommended if several exist)
  DEVICE_NAME=<name>      Appium device name
  APPIUM_SERVER_URL=<url> Existing Appium server (default: http://127.0.0.1:4723)
  START_APPIUM=0          Do not start Appium when the server is unavailable
  KEEP_SESSION=1          Keep the Appium session alive after the script exits

iOS:
  IOS_BUNDLE_ID=<id>      Bundle ID of the installed Playbypoint app (required)

Selector overrides (strategy=value):
  EMAIL_SELECTOR
  PASSWORD_SELECTOR
  SIGN_IN_SELECTOR
  SUBMIT_SELECTOR
  SUCCESS_SELECTOR        Optional selector that positively confirms login

Examples of selector values:
  'accessibility id=email'
  'id=com.playbypoint.appx:id/email'
  'xpath=//android.widget.EditText[1]'
USAGE
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

json_quote() {
  "$PYTHON_BIN" -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
}

json_value() {
  local path="$1"
  "$PYTHON_BIN" -c '
import json, sys
keys = sys.argv[1].split(".")
try:
    value = json.load(sys.stdin)
    for key in keys:
        value = value[key]
    print(value if isinstance(value, str) else json.dumps(value))
except (KeyError, TypeError, ValueError, json.JSONDecodeError):
    pass
' "$path"
}

api() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local args=(-sS -X "$method" -H 'Content-Type: application/json')

  if [[ -n "$body" ]]; then
    printf '%s' "$body" | curl "${args[@]}" --data-binary @- "${APPIUM_SERVER_URL}${path}"
  else
    curl "${args[@]}" "${APPIUM_SERVER_URL}${path}"
  fi
}

server_is_ready() {
  curl -fsS "${APPIUM_SERVER_URL}/status" >/dev/null 2>&1
}

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM

  if [[ -n "$SESSION_ID" && "$KEEP_SESSION" != "1" ]]; then
    api DELETE "/session/${SESSION_ID}" >/dev/null 2>&1 || true
  fi
  if [[ -n "$APPIUM_PID" ]]; then
    kill "$APPIUM_PID" >/dev/null 2>&1 || true
    wait "$APPIUM_PID" >/dev/null 2>&1 || true
  fi
  exit "$exit_code"
}

split_selector() {
  local selector="$1"
  SELECTOR_STRATEGY="${selector%%=*}"
  SELECTOR_VALUE="${selector#*=}"
  [[ "$selector" == *=* && -n "$SELECTOR_STRATEGY" && -n "$SELECTOR_VALUE" ]]
}

find_element_once() {
  local strategy="$1"
  local selector="$2"
  local strategy_json selector_json response element_id
  strategy_json="$(printf '%s' "$strategy" | json_quote)"
  selector_json="$(printf '%s' "$selector" | json_quote)"
  response="$(api POST "/session/${SESSION_ID}/element" \
    "{\"using\":${strategy_json},\"value\":${selector_json}}")" || return 1
  element_id="$(printf '%s' "$response" | json_value 'value.element-6066-11e4-a52e-4f735466cecf')"
  if [[ -z "$element_id" ]]; then
    element_id="$(printf '%s' "$response" | json_value 'value.ELEMENT')"
  fi
  [[ -n "$element_id" ]] || return 1
  printf '%s' "$element_id"
}

find_with_candidates() {
  local timeout="$1"
  local label="$2"
  shift 2
  local candidates=("$@")
  local deadline=$((SECONDS + timeout))
  local index element_id

  while (( SECONDS < deadline )); do
    for ((index = 0; index < ${#candidates[@]}; index += 2)); do
      if element_id="$(find_element_once "${candidates[index]}" "${candidates[index + 1]}")"; then
        printf '%s' "$element_id"
        return 0
      fi
    done
    sleep 1
  done
  printf 'Could not find %s within %ss. Set its *_SELECTOR override if the app UI changed.\n' \
    "$label" "$timeout" >&2
  return 1
}

any_candidate_exists() {
  local candidates=("$@")
  local index
  for ((index = 0; index < ${#candidates[@]}; index += 2)); do
    if find_element_once "${candidates[index]}" "${candidates[index + 1]}" >/dev/null 2>&1; then
      return 0
    fi
  done
  return 1
}

find_any_candidate_once() {
  local candidates=("$@")
  local index element_id
  for ((index = 0; index < ${#candidates[@]}; index += 2)); do
    if element_id="$(find_element_once "${candidates[index]}" "${candidates[index + 1]}")"; then
      printf '%s' "$element_id"
      return 0
    fi
  done
  return 1
}

click_element() {
  api POST "/session/${SESSION_ID}/element/$1/click" '{}' >/dev/null
}

type_into() {
  local element_id="$1"
  local value="$2"
  local body
  api POST "/session/${SESSION_ID}/element/${element_id}/clear" '{}' >/dev/null 2>&1 || true
  body="$(printf '%s' "$value" | "$PYTHON_BIN" -c '
import json, sys
text = sys.stdin.read()
print(json.dumps({"text": text, "value": list(text)}))
')"
  api POST "/session/${SESSION_ID}/element/${element_id}/value" "$body" >/dev/null
}

dismiss_notification_prompt() {
  [[ "$PLATFORM" == "android" ]] || return 0

  local -a notification_text_candidates=(
    'xpath' '//*[contains(translate(@text,"NOTIFICATIONS","notifications"),"notification")]'
  )
  local -a deny_candidates=(
    'id' 'com.android.permissioncontroller:id/permission_deny_and_dont_ask_again_button'
    'id' 'com.android.permissioncontroller:id/permission_deny_button'
    'accessibility id' "Don't allow"
    'accessibility id' 'Don’t allow'
    'xpath' '//*[(contains(@text,"Don") or contains(@label,"Don")) and (contains(@text,"allow") or contains(@label,"allow"))]'
  )
  local deadline=$((SECONDS + NOTIFICATION_PROMPT_TIMEOUT))
  local alert_response alert_text deny_element hierarchy tap_coordinates tap_x tap_y
  local -a adb_args=()
  [[ -n "${UDID:-}" ]] && adb_args=(-s "$UDID")

  while (( SECONDS < deadline )); do
    alert_response="$(api GET "/session/${SESSION_ID}/alert/text" 2>/dev/null || true)"
    alert_text="$(printf '%s' "$alert_response" | json_value 'value')"
    if [[ "$alert_text" == *notification* || "$alert_text" == *Notification* ]]; then
      if api POST "/session/${SESSION_ID}/alert/dismiss" '{}' >/dev/null 2>&1; then
        printf 'Notification permission declined through the Android alert.\n'
        return 0
      fi
    fi

    if find_any_candidate_once "${notification_text_candidates[@]}" >/dev/null 2>&1; then
      if deny_element="$(find_any_candidate_once "${deny_candidates[@]}" 2>/dev/null)"; then
        click_element "$deny_element"
        printf 'Notification permission declined.\n'
        return 0
      fi
    fi

    if command_exists adb; then
      hierarchy="$(adb "${adb_args[@]}" exec-out uiautomator dump /dev/tty 2>/dev/null || true)"
      tap_coordinates="$(printf '%s' "$hierarchy" | "$PYTHON_BIN" -c '
import re, sys, xml.etree.ElementTree as ET
data = sys.stdin.read()
start, end = data.find("<?xml"), data.find("</hierarchy>")
if start < 0 or end < 0:
    raise SystemExit
try:
    root = ET.fromstring(data[start:end + len("</hierarchy>")])
except ET.ParseError:
    raise SystemExit
nodes = list(root.iter("node"))
if not any("notification" in node.attrib.get("text", "").lower() for node in nodes):
    raise SystemExit
ids = {
    "com.android.permissioncontroller:id/permission_deny_and_dont_ask_again_button",
    "com.android.permissioncontroller:id/permission_deny_button",
}
for node in nodes:
    if node.attrib.get("resource-id") not in ids:
        continue
    match = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", node.attrib.get("bounds", ""))
    if match:
        x1, y1, x2, y2 = map(int, match.groups())
        print((x1 + x2) // 2, (y1 + y2) // 2)
        break
')"
      if [[ -n "$tap_coordinates" ]]; then
        read -r tap_x tap_y <<<"$tap_coordinates"
        adb "${adb_args[@]}" shell input tap "$tap_x" "$tap_y" >/dev/null
        printf 'Notification permission declined through the Android system UI.\n'
        return 0
      fi
    fi
    sleep 1
  done

  printf 'No notification prompt detected.\n'
}

click_first_candidate() {
  local timeout="$1"
  local label="$2"
  shift 2
  local element_id
  element_id="$(find_with_candidates "$timeout" "$label" "$@")"
  click_element "$element_id"
}

swipe_date_strip_left() {
  api POST "/session/${SESSION_ID}/actions" '{
    "actions":[{
      "type":"pointer",
      "id":"date-strip-finger",
      "parameters":{"pointerType":"touch"},
      "actions":[
        {"type":"pointerMove","duration":0,"x":900,"y":400},
        {"type":"pointerDown","button":0},
        {"type":"pause","duration":100},
        {"type":"pointerMove","duration":500,"x":150,"y":400},
        {"type":"pointerUp","button":0}
      ]
    }]
  }' >/dev/null
  api DELETE "/session/${SESSION_ID}/actions" >/dev/null 2>&1 || true
}

swipe_date_strip_right() {
  api POST "/session/${SESSION_ID}/actions" '{
    "actions":[{
      "type":"pointer",
      "id":"date-strip-finger",
      "parameters":{"pointerType":"touch"},
      "actions":[
        {"type":"pointerMove","duration":0,"x":150,"y":400},
        {"type":"pointerDown","button":0},
        {"type":"pause","duration":100},
        {"type":"pointerMove","duration":500,"x":900,"y":400},
        {"type":"pointerUp","button":0}
      ]
    }]
  }' >/dev/null
  api DELETE "/session/${SESSION_ID}/actions" >/dev/null 2>&1 || true
}

scroll_booking_details_into_view() {
  api POST "/session/${SESSION_ID}/actions" '{
    "actions":[{
      "type":"pointer",
      "id":"booking-details-finger",
      "parameters":{"pointerType":"touch"},
      "actions":[
        {"type":"pointerMove","duration":0,"x":540,"y":1950},
        {"type":"pointerDown","button":0},
        {"type":"pause","duration":100},
        {"type":"pointerMove","duration":500,"x":540,"y":900},
        {"type":"pointerUp","button":0}
      ]
    }]
  }' >/dev/null
  api DELETE "/session/${SESSION_ID}/actions" >/dev/null 2>&1 || true
  sleep 0.5
}

booking_target_date_label() {
  local emulator_date=""
  local -a adb_args=()
  [[ -n "${UDID:-}" ]] && adb_args=(-s "$UDID")
  if command_exists adb; then
    emulator_date="$(adb "${adb_args[@]}" shell date +%Y-%m-%d 2>/dev/null | tr -d '\r')"
  fi
  printf '%s' "$emulator_date" | "$PYTHON_BIN" -c '
from datetime import datetime, timedelta
import sys
value = sys.stdin.read().strip()
try:
    today = datetime.strptime(value, "%Y-%m-%d")
except ValueError:
    today = datetime.now().astimezone().replace(tzinfo=None)
print((today + timedelta(days=7)).strftime("%a, %d, %b"))
'
}

parse_selected_court_hierarchy() {
  "$PYTHON_BIN" -c '
import re, sys, xml.etree.ElementTree as ET
data = sys.stdin.read()
start, end = data.find("<?xml"), data.find("</hierarchy>")
if start < 0 or end < 0:
    raise SystemExit
try:
    root = ET.fromstring(data[start:end + len("</hierarchy>")])
except ET.ParseError:
    raise SystemExit
for node in root.iter("node"):
    match = re.search(r",\s*Pickleball\s+(\d+)\s*$", node.attrib.get("text", ""), re.IGNORECASE)
    if match:
        print(match.group(1))
        break
'
}

current_selected_court() {
  local hierarchy="" selected_court="" source_response
  source_response="$(api GET "/session/${SESSION_ID}/source" 2>/dev/null || true)"
  hierarchy="$(printf '%s' "$source_response" | json_value 'value')"
  selected_court="$(printf '%s' "$hierarchy" | parse_selected_court_hierarchy)"
  if [[ -n "$selected_court" ]]; then
    printf '%s' "$selected_court"
    return 0
  fi

  if [[ "$PLATFORM" == "android" ]] && command_exists adb; then
    local -a adb_args=()
    [[ -n "${UDID:-}" ]] && adb_args=(-s "$UDID")
    hierarchy="$(adb "${adb_args[@]}" exec-out uiautomator dump /dev/tty 2>/dev/null || true)"
    printf '%s' "$hierarchy" | parse_selected_court_hierarchy
  fi
}

select_preferred_court() {
  local announce_unavailable="${1:-1}"
  local court court_label court_element selected_court
  selected_court="$(current_selected_court)"
  if [[ -n "$selected_court" && "$announce_unavailable" == "1" ]]; then
    printf 'Court %s is currently selected.\n' "$selected_court"
  fi
  for court in "${COURT_PRIORITY[@]}"; do
    court_label="PICKLEBALL ${court}"
    [[ "$announce_unavailable" == "1" ]] && printf 'Trying preferred court %s...\n' "$court"
    if [[ "$court" == "$selected_court" ]]; then
      printf 'Preferred court %s is already selected; no click is needed.\n' "$court"
      return 0
    fi
    if court_element="$(find_element_once 'accessibility id' "$court_label" 2>/dev/null)"; then
      click_element "$court_element"
      printf 'Selected court %s.\n' "$court"
      return 0
    fi
    [[ "$announce_unavailable" == "1" ]] && \
      printf 'Court %s is unavailable; trying the next preference.\n' "$court"
  done
  [[ "$announce_unavailable" == "1" ]] && \
    printf 'None of the preferred courts are currently available. No reservation was submitted.\n'
  return 1
}

click_court_selection_next() {
  printf 'Clicking Next after court selection...\n'
  click_first_candidate "$BOOKING_TIMEOUT" 'court selection Next button' \
    'xpath' '//*[@text="NEXT" or starts-with(@content-desc,"NEXT")]' \
    'accessibility id' 'NEXT'
  printf 'Advanced past court selection.\n'
}

run_booking_flow() {
  [[ "$RUN_BOOKING_FLOW" == "1" ]] || {
    printf 'Booking navigation disabled (RUN_BOOKING_FLOW=%s).\n' "$RUN_BOOKING_FLOW"
    return 0
  }

  local -a book_now_candidates=(
    'accessibility id' 'Book now'
    'id' 'club-book-now-button'
    'xpath' '//*[@text="Book now" or @content-desc="Book now"]'
  )
  local -a reserve_candidates=(
    'accessibility id' 'Book Now, Reserve a full court.'
    'xpath' '//*[@content-desc="Book Now, Reserve a full court." or @text="Reserve a full court."]'
  )
  local -a next_candidates=(
    'id' 'club-book-now-next-button'
    'accessibility id' 'Next'
    'xpath' '//*[@text="Next" or @text="NEXT" or @content-desc="Next"]'
  )
  local -a pickleball_candidates=(
    'accessibility id' 'PICKLEBALL'
    'xpath' '//*[@text="PICKLEBALL" or @content-desc="PICKLEBALL"]'
  )
  local -a clubs_tab_candidates=(
    'id' 'tab-clubs'
    'accessibility id' 'Clubs'
  )

  local pickleball_element book_now_element clubs_tab_element
  book_now_element="$(find_any_candidate_once "${book_now_candidates[@]}" 2>/dev/null || true)"
  if [[ -z "$book_now_element" ]]; then
    if clubs_tab_element="$(find_any_candidate_once "${clubs_tab_candidates[@]}" 2>/dev/null)"; then
      printf 'Opening the Clubs tab after the fresh app launch...\n'
      click_element "$clubs_tab_element"
      book_now_element="$(find_with_candidates "$BOOKING_TIMEOUT" 'Book now button' "${book_now_candidates[@]}")"
    fi
  fi
  [[ -n "$book_now_element" ]] || die "Could not find the club page containing Book now after fresh app launch"

  printf 'Clicking Book now...\n'
  click_element "$book_now_element"
  printf 'Selecting Reserve a full court...\n'
  click_first_candidate "$BOOKING_TIMEOUT" 'Reserve a full court option' "${reserve_candidates[@]}"
  printf 'Clicking Next...\n'
  click_first_candidate "$BOOKING_TIMEOUT" 'booking Next button' "${next_candidates[@]}"
  pickleball_element="$(find_with_candidates "$BOOKING_TIMEOUT" 'Pickleball option' "${pickleball_candidates[@]}")"

  printf 'Selecting Pickleball...\n'
  click_element "$pickleball_element"

  local target_label target_element attempt
  target_label="$(booking_target_date_label)"
  printf 'Selecting booking date exactly 7 days from today: %s...\n' "$target_label"
  # First recover if a previous run left the strip scrolled past the target.
  for attempt in 1 2 3 4; do
    if target_element="$(find_element_once 'accessibility id' "$target_label" 2>/dev/null)"; then
      click_element "$target_element"
      printf 'Selected booking date: %s.\n' "$target_label"
      break
    fi
    swipe_date_strip_right
  done
  # Then move forward from the beginning until day +7 is visible.
  if [[ -z "$target_element" ]]; then
    for attempt in 1 2 3 4 5 6 7 8; do
      if target_element="$(find_element_once 'accessibility id' "$target_label" 2>/dev/null)"; then
        click_element "$target_element"
        printf 'Selected booking date: %s.\n' "$target_label"
        break
      fi
      swipe_date_strip_left
    done
  fi
  [[ -n "$target_element" ]] || die "Could not find booking date '${target_label}' after scrolling the date strip"

  local slot slot_element
  local selected_slot_count=0
  local booked_slot=""
  for slot in "${BOOKING_TIME_SLOTS[@]}"; do
    # Available slots expose the exact accessibility label. Check that fast path
    # first; only evaluate the more expensive booked/red XPath when it is absent.
    if slot_element="$(find_element_once 'accessibility id' "$slot" 2>/dev/null)"; then
      printf 'Selecting time slot: %s...\n' "$slot"
      click_element "$slot_element"
      selected_slot_count=$((selected_slot_count + 1))
      continue
    fi
    if find_element_once 'xpath' \
      "//*[starts-with(@content-desc,\"${slot},\")]" >/dev/null 2>&1; then
      booked_slot="$slot"
      printf 'Time slot %s is already booked (red status); leaving it untouched and stopping slot selection.\n' "$slot"
      break
    fi
    booked_slot="$slot"
    printf 'Time slot %s is not selectable; leaving it untouched and continuing to court selection.\n' "$slot"
    break
  done
  if [[ -n "$booked_slot" ]]; then
    printf 'Selected %s available slot(s) before the booked slot. No reservation was submitted.\n' \
      "$selected_slot_count"
  else
    printf 'Selected all %s configured time slots. No reservation was submitted.\n' \
      "$selected_slot_count"
  fi

  printf 'Bringing court selection into view...\n'
  scroll_booking_details_into_view
  if select_preferred_court 1; then
    click_court_selection_next
  else
    printf 'Court preference handling completed without a selection. No reservation was submitted.\n'
  fi
}

main() {
  [[ "${1:-}" != "-h" && "${1:-}" != "--help" ]] || { usage; exit 0; }
  [[ $# -eq 0 ]] || { usage >&2; die "Unexpected arguments"; }
  command_exists curl || die "curl is required"
  if command_exists python3; then
    PYTHON_BIN="$(command -v python3)"
  elif command_exists python; then
    PYTHON_BIN="$(command -v python)"
  else
    die "Python 3 is required"
  fi
  "$PYTHON_BIN" -c 'import sys; raise SystemExit(0 if sys.version_info.major == 3 else 1)' || \
    die "Python 3 is required"
  [[ -n "${PLAYBYPOINT_EMAIL:-}" ]] || die "PLAYBYPOINT_EMAIL is required"
  [[ -n "${PLAYBYPOINT_PASSWORD:-}" ]] || die "PLAYBYPOINT_PASSWORD is required"
  [[ "$PLATFORM" == "android" || "$PLATFORM" == "ios" ]] || die "PLATFORM must be android or ios"
  if [[ "$PLATFORM" == "ios" && -z "$IOS_BUNDLE_ID" ]]; then
    die "IOS_BUNDLE_ID is required for iOS"
  fi

  trap cleanup EXIT INT TERM

  if ! server_is_ready; then
    [[ "$START_APPIUM" == "1" ]] || die "Appium is not reachable at ${APPIUM_SERVER_URL}"
    command_exists appium || die "Appium is not running and the 'appium' command is unavailable"
    printf 'Starting Appium (log: %s)...\n' "$APPIUM_LOG"
    appium >"$APPIUM_LOG" 2>&1 &
    APPIUM_PID=$!
    for _ in {1..30}; do
      server_is_ready && break
      sleep 1
    done
    server_is_ready || die "Appium did not become ready; inspect ${APPIUM_LOG}"
  fi

  local automation app_id platform_name platform_capabilities udid_capabilities session_payload response
  if [[ "$PLATFORM" == "android" ]]; then
    automation="UiAutomator2"
    app_id="$ANDROID_PACKAGE"
    platform_name="Android"
    platform_capabilities=',"appium:autoGrantPermissions":false,"appium:settings[enableMultiWindows]":true'
  else
    automation="XCUITest"
    app_id="$IOS_BUNDLE_ID"
    platform_name="iOS"
    platform_capabilities=',"appium:autoAcceptAlerts":true'
  fi
  udid_capabilities=""
  if [[ -n "${UDID:-}" ]]; then
    udid_capabilities=",\"appium:udid\":$(printf '%s' "$UDID" | json_quote)"
  fi
  session_payload="{\"capabilities\":{\"alwaysMatch\":{\"platformName\":\"${platform_name}\",\"appium:automationName\":\"${automation}\",\"appium:deviceName\":$(printf '%s' "$DEVICE_NAME" | json_quote),\"appium:noReset\":true,\"appium:newCommandTimeout\":120${platform_capabilities}${udid_capabilities}},\"firstMatch\":[{}]}}"
  response="$(api POST /session "$session_payload")"
  SESSION_ID="$(printf '%s' "$response" | json_value 'value.sessionId')"
  [[ -n "$SESSION_ID" ]] || SESSION_ID="$(printf '%s' "$response" | json_value 'sessionId')"
  [[ -n "$SESSION_ID" ]] || die "Could not create Appium session: ${response}"

  printf 'Closing any existing Playbypoint app process...\n'
  api POST "/session/${SESSION_ID}/execute/sync" \
    "{\"script\":\"mobile: terminateApp\",\"args\":[{\"appId\":$(printf '%s' "$app_id" | json_quote)}]}" >/dev/null 2>&1 || true
  sleep 3

  printf 'Opening Playbypoint on %s...\n' "$platform_name"
  api POST "/session/${SESSION_ID}/execute/sync" \
    "{\"script\":\"mobile: activateApp\",\"args\":[{\"appId\":$(printf '%s' "$app_id" | json_quote)}]}" >/dev/null

  local -a email_candidates password_candidates sign_in_candidates submit_candidates success_candidates
  if [[ -n "${EMAIL_SELECTOR:-}" ]]; then
    split_selector "$EMAIL_SELECTOR" || die "Invalid EMAIL_SELECTOR; expected strategy=value"
    email_candidates=("$SELECTOR_STRATEGY" "$SELECTOR_VALUE")
  else
    email_candidates=(
      'accessibility id' 'email'
      'accessibility id' 'Email'
      'xpath' '//android.widget.EditText[contains(translate(@text,"EMAIL","email"),"email")][1]'
      'xpath' '(//android.widget.EditText)[1]'
      'xpath' '//XCUIElementTypeTextField[1]'
    )
  fi
  if [[ -n "${PASSWORD_SELECTOR:-}" ]]; then
    split_selector "$PASSWORD_SELECTOR" || die "Invalid PASSWORD_SELECTOR; expected strategy=value"
    password_candidates=("$SELECTOR_STRATEGY" "$SELECTOR_VALUE")
  else
    password_candidates=(
      'accessibility id' 'password'
      'accessibility id' 'Password'
      'xpath' '//android.widget.EditText[@password="true"]'
      'xpath' '(//android.widget.EditText)[2]'
      'xpath' '//XCUIElementTypeSecureTextField[1]'
    )
  fi
  if [[ -n "${SIGN_IN_SELECTOR:-}" ]]; then
    split_selector "$SIGN_IN_SELECTOR" || die "Invalid SIGN_IN_SELECTOR; expected strategy=value"
    sign_in_candidates=("$SELECTOR_STRATEGY" "$SELECTOR_VALUE")
  else
    sign_in_candidates=(
      'accessibility id' 'Sign In'
      'xpath' '//*[@text="Sign In" or @label="Sign In" or @name="Sign In"]'
      'xpath' '//*[@text="SIGN IN" or @label="SIGN IN" or @name="SIGN IN"]'
    )
  fi
  if [[ -n "${SUBMIT_SELECTOR:-}" ]]; then
    split_selector "$SUBMIT_SELECTOR" || die "Invalid SUBMIT_SELECTOR; expected strategy=value"
    submit_candidates=("$SELECTOR_STRATEGY" "$SELECTOR_VALUE")
  else
    submit_candidates=("${sign_in_candidates[@]}")
  fi

  local email_element password_element sign_in_element submit_element
  local prompt_type=""
  local prompt_deadline=$((SECONDS + LOGIN_PROMPT_TIMEOUT))
  while (( SECONDS < prompt_deadline )); do
    if email_element="$(find_any_candidate_once "${email_candidates[@]}" 2>/dev/null)"; then
      prompt_type="email"
      break
    fi
    if sign_in_element="$(find_any_candidate_once "${sign_in_candidates[@]}" 2>/dev/null)"; then
      prompt_type="sign_in"
      break
    fi
    sleep 1
  done

  if [[ "$prompt_type" == "email" ]]; then
    printf 'Login form detected.\n'
  elif [[ "$prompt_type" == "sign_in" ]]; then
    printf 'Sign In prompt detected.\n'
    click_element "$sign_in_element"
    email_element="$(find_with_candidates "$ELEMENT_TIMEOUT" 'email field' "${email_candidates[@]}")"
  else
    printf 'No login prompt detected; preserving the existing authenticated session.\n'
    dismiss_notification_prompt
    printf 'Playbypoint is ready.\n'
    run_booking_flow
    return 0
  fi
  password_element="$(find_with_candidates "$ELEMENT_TIMEOUT" 'password field' "${password_candidates[@]}")"

  printf 'Entering credentials and signing in...\n'
  type_into "$email_element" "$PLAYBYPOINT_EMAIL"
  type_into "$password_element" "$PLAYBYPOINT_PASSWORD"
  submit_element="$(find_with_candidates "$ELEMENT_TIMEOUT" 'Sign In submit button' "${submit_candidates[@]}")"
  click_element "$submit_element"
  dismiss_notification_prompt

  if [[ -n "${SUCCESS_SELECTOR:-}" ]]; then
    split_selector "$SUCCESS_SELECTOR" || die "Invalid SUCCESS_SELECTOR; expected strategy=value"
    success_candidates=("$SELECTOR_STRATEGY" "$SELECTOR_VALUE")
    find_with_candidates "$LOGIN_TIMEOUT" 'post-login success element' "${success_candidates[@]}" >/dev/null
  else
    local deadline=$((SECONDS + LOGIN_TIMEOUT))
    while (( SECONDS < deadline )); do
      if ! any_candidate_exists "${password_candidates[@]}"; then
        printf 'Login completed; the sign-in form is no longer visible.\n'
        run_booking_flow
        return 0
      fi
      sleep 1
    done
    die "Login was submitted, but the sign-in form remained visible. Check the credentials or set SUCCESS_SELECTOR."
  fi

  printf 'Login completed and SUCCESS_SELECTOR was found.\n'
  run_booking_flow
}

main "$@"
