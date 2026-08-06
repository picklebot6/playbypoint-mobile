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
readonly APPIUM_START_TIMEOUT="${APPIUM_START_TIMEOUT:-180}"
readonly TIME_SLOT_AVAILABILITY_TIMEOUT="${TIME_SLOT_AVAILABILITY_TIMEOUT:-300}"
readonly ADDITIONAL_PLAYER_NAME="${ADDITIONAL_PLAYER_NAME:-Paul Rodriguez}"
readonly ELEMENT_POLL_INTERVAL="${ELEMENT_POLL_INTERVAL:-0.1}"
readonly TIME_SLOT_POLL_INTERVAL="${TIME_SLOT_POLL_INTERVAL:-0.05}"
readonly CONFIRMATION_TIMEOUT="${CONFIRMATION_TIMEOUT:-30}"
readonly CONFIRMATION_FILE="${CONFIRMATION_FILE:-${PROJECT_DIR}/logs/playbypoint-confirmation.txt}"
readonly BOOKING_FAILURE_FILE="${BOOKING_FAILURE_FILE:-${PROJECT_DIR}/logs/playbypoint-booking-failure.txt}"

# Editable consecutive booking slots. Keep the labels exactly as displayed by
# Playbypoint; the booking flow selects each entry in this order.
BOOKING_TIME_SLOTS=(
  '2:30-3pm'
  '3-3:30pm'
  '3:30-4pm'
  '4-4:30pm'
  # '7:30-8pm'
  # '8-8:30pm'
  # '8:30-9pm'
  # '9-9:30pm'
)

# Editable court preference, from highest to lowest priority. The first court
# present on the availability screen is selected.
COURT_PRIORITY=(4 3 8 9 2 6 1 5 10 7)
COURT_PRIORITY_START_INDEX=0
CURRENT_BOOKING_COURT_INDEX=-1
CURRENT_BOOKING_COURT=""
readonly KEEP_SESSION="${KEEP_SESSION:-0}"
readonly START_APPIUM="${START_APPIUM:-1}"
readonly APPIUM_LOG="${APPIUM_LOG:-${PROJECT_DIR}/logs/playbypoint-appium.log}"

SESSION_ID=""
APPIUM_PID=""
PYTHON_CMD=()

usage() {
  cat <<'USAGE'
Usage:
  PLAYBYPOINT_EMAIL='player@example.com' \
  PLAYBYPOINT_PASSWORD='secret' \
  ./scripts/playbypoint-login.sh

Required:
  PLAYBYPOINT_EMAIL       Playbypoint account email
  PLAYBYPOINT_PASSWORD    Playbypoint account password

Optional booking configuration:
  ADDITIONAL_PLAYER_NAME  Exact player name to search for and add

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
  "${PYTHON_CMD[@]}" -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
}

json_value() {
  local path="$1"
  "${PYTHON_CMD[@]}" -c '
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

xpath_literal() {
  printf '%s' "$1" | "${PYTHON_CMD[@]}" -c '
import sys
value = sys.stdin.read()
if "\x27" not in value:
    print("\x27" + value + "\x27")
elif "\x22" not in value:
    print("\x22" + value + "\x22")
else:
    parts = value.split("\x27")
    print("concat(" + ", \"\x27\", ".join("\x27" + part + "\x27" for part in parts) + ")")
'
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
  curl -fsS --connect-timeout 1 --max-time 2 "${APPIUM_SERVER_URL}/status" >/dev/null 2>&1
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
    sleep "$ELEMENT_POLL_INTERVAL"
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
  body="$(printf '%s' "$value" | "${PYTHON_CMD[@]}" -c '
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
      tap_coordinates="$(printf '%s' "$hierarchy" | "${PYTHON_CMD[@]}" -c '
import re, sys, xml.etree.ElementTree as ET
data = sys.stdin.read()
start, end = data.find("<?xml"), data.find("</hierarchy>")
if start < 0 or end < 0:
    raise SystemExit
try:
    root = ET.fromstring(data[start:end + len("</hierarchy>")])
except ET.ParseError:
    raise SystemExit
nodes = list(root.iter())
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
    sleep "$ELEMENT_POLL_INTERVAL"
  done

  printf 'No notification prompt detected.\n'
}

click_first_candidate() {
  local timeout="$1"
  local label="$2"
  shift 2
  local element_id
  element_id="$(find_with_candidates "$timeout" "$label" "$@")" || return 1
  [[ -n "$element_id" ]] || return 1
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
        {"type":"pause","duration":10},
        {"type":"pointerMove","duration":100,"x":150,"y":400},
        {"type":"pointerUp","button":0}
      ]
    }]
  }' >/dev/null
  api DELETE "/session/${SESSION_ID}/actions" >/dev/null 2>&1 || true
}

swipe_date_strip_all_the_way_right() {
  local rect_response screen_width screen_height start_x end_x y
  rect_response="$(api GET "/session/${SESSION_ID}/window/rect")"
  screen_width="$(printf '%s' "$rect_response" | json_value 'value.width')"
  screen_height="$(printf '%s' "$rect_response" | json_value 'value.height')"
  [[ "$screen_width" =~ ^[0-9]+$ && "$screen_height" =~ ^[0-9]+$ ]] || \
    die "Could not determine the Android window size before resetting the date strip"

  # Stay well clear of Android's left-edge Back gesture while retaining enough
  # velocity for the date strip to coast to its rightmost position.
  start_x=$((screen_width * 35 / 100))
  end_x=$((screen_width * 90 / 100))
  y=$((screen_height / 6))
  api POST "/session/${SESSION_ID}/actions" "{
    \"actions\":[{
      \"type\":\"pointer\",
      \"id\":\"date-strip-reset-finger\",
      \"parameters\":{\"pointerType\":\"touch\"},
      \"actions\":[
        {\"type\":\"pointerMove\",\"duration\":0,\"x\":${start_x},\"y\":${y}},
        {\"type\":\"pointerDown\",\"button\":0},
        {\"type\":\"pause\",\"duration\":10},
        {\"type\":\"pointerMove\",\"duration\":100,\"x\":${end_x},\"y\":${y}},
        {\"type\":\"pointerUp\",\"button\":0}
      ]
    }]
  }" >/dev/null
  api DELETE "/session/${SESSION_ID}/actions" >/dev/null 2>&1 || true
}

scroll_booking_details_into_view() {
  local rect_response screen_width screen_height left top width height response can_scroll_more attempt
  rect_response="$(api GET "/session/${SESSION_ID}/window/rect")"
  screen_width="$(printf '%s' "$rect_response" | json_value 'value.width')"
  screen_height="$(printf '%s' "$rect_response" | json_value 'value.height')"
  [[ "$screen_width" =~ ^[0-9]+$ && "$screen_height" =~ ^[0-9]+$ ]] || \
    die "Could not determine the Android window size before locating Select detail"

  left=$((screen_width / 20))
  top=$((screen_height / 4))
  width=$((screen_width * 9 / 10))
  height=$((screen_height * 3 / 5))

  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if find_element_once 'xpath' \
      '//*[@text="Select detail" or @content-desc="Select detail"]' >/dev/null 2>&1; then
      printf 'Select detail and the court carousel are in view.\n'
      return 0
    fi
    response="$(api POST "/session/${SESSION_ID}/execute/sync" \
      "{\"script\":\"mobile: scrollGesture\",\"args\":[{\"left\":${left},\"top\":${top},\"width\":${width},\"height\":${height},\"direction\":\"down\",\"percent\":0.9}]}")"
    can_scroll_more="$(printf '%s' "$response" | json_value 'value')"
    if [[ "$can_scroll_more" == "false" ]]; then
      break
    fi
    [[ "$can_scroll_more" == "true" ]] || die "Could not scroll toward Select detail: ${response}"
  done

  find_element_once 'xpath' \
    '//*[@text="Select detail" or @content-desc="Select detail"]' >/dev/null 2>&1 || \
    die "Could not bring Select detail and the court carousel into view"
  printf 'Select detail and the court carousel are in view.\n'
}

scroll_booking_to_bottom() {
  local rect_response screen_width screen_height left top width height response can_scroll_more attempt
  rect_response="$(api GET "/session/${SESSION_ID}/window/rect")"
  screen_width="$(printf '%s' "$rect_response" | json_value 'value.width')"
  screen_height="$(printf '%s' "$rect_response" | json_value 'value.height')"
  [[ "$screen_width" =~ ^[0-9]+$ && "$screen_height" =~ ^[0-9]+$ ]] || \
    die "Could not determine the Android window size before scrolling"

  left=$((screen_width / 20))
  top=$((screen_height / 4))
  width=$((screen_width * 9 / 10))
  height=$((screen_height * 3 / 5))

  printf 'Scrolling booking availability all the way to the bottom...\n'
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    response="$(api POST "/session/${SESSION_ID}/execute/sync" \
      "{\"script\":\"mobile: scrollGesture\",\"args\":[{\"left\":${left},\"top\":${top},\"width\":${width},\"height\":${height},\"direction\":\"down\",\"percent\":1.0}]}")"
    can_scroll_more="$(printf '%s' "$response" | json_value 'value')"
    if [[ "$can_scroll_more" == "false" ]]; then
      break
    fi
    [[ "$can_scroll_more" == "true" ]] || die "Could not scroll booking availability: ${response}"
  done
  [[ "$can_scroll_more" != "true" ]] || die "Booking availability was still scrollable after 10 downward gestures"
  printf 'Reached the bottom of booking availability.\n'
}

wait_for_time_slot_availability() {
  local deadline=$((SECONDS + TIME_SLOT_AVAILABILITY_TIMEOUT))
  local slot="${BOOKING_TIME_SLOTS[0]:-}"
  [[ -n "$slot" ]] || die "BOOKING_TIME_SLOTS must contain at least one slot"

  printf 'Waiting up to %ss for time selections to become available...\n' \
    "$TIME_SLOT_AVAILABILITY_TIMEOUT"
  while (( SECONDS < deadline )); do
    if find_element_once 'accessibility id' "$slot" >/dev/null 2>&1 || \
       find_element_once 'xpath' "//*[starts-with(@content-desc,\"${slot},\")]" >/dev/null 2>&1; then
      printf 'Time selections are available.\n'
      return 0
    fi

    sleep "$TIME_SLOT_POLL_INTERVAL"
  done

  die "Time selections did not become available within ${TIME_SLOT_AVAILABILITY_TIMEOUT}s"
}

plan_time_slot_selection() {
  local source_response hierarchy
  source_response="$(api GET "/session/${SESSION_ID}/source" 2>/dev/null || true)"
  hierarchy="$(printf '%s' "$source_response" | json_value 'value')"
  printf '%s' "$hierarchy" | "${PYTHON_CMD[@]}" -c '
import re
import sys
import xml.etree.ElementTree as ET

data = sys.stdin.read()
start, end = data.find("<?xml"), data.rfind("</hierarchy>")
if start < 0 or end < 0:
    raise SystemExit
try:
    root = ET.fromstring(data[start:end + len("</hierarchy>")])
except ET.ParseError:
    raise SystemExit

nodes = list(root.iter())
for index, slot in enumerate(sys.argv[1:]):
    available = next((node for node in nodes if
        node.attrib.get("content-desc") == slot or node.attrib.get("text") == slot), None)
    booked = next((node for node in nodes if
        node.attrib.get("content-desc", "").startswith(slot + ",") or
        node.attrib.get("text", "").startswith(slot + ",")), None)
    node = available if available is not None else booked
    if node is None:
        print(f"missing\t{slot}\t\t")
        if index == 0:
            continue
        break
    match = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", node.attrib.get("bounds", ""))
    if match is None:
        print(f"missing\t{slot}\t\t")
        if index == 0:
            continue
        break
    x1, y1, x2, y2 = map(int, match.groups())
    status = "available" if available is not None else "booked"
    print(f"{status}\t{slot}\t{(x1 + x2) // 2}\t{(y1 + y2) // 2}")
    if status == "booked" and index != 0:
        break
' "${BOOKING_TIME_SLOTS[@]}"
}

expected_time_range_from_slots() {
  "${PYTHON_CMD[@]}" -c '
import sys
start = sys.argv[1].split("-", 1)[0]
end = sys.argv[2].rsplit("-", 1)[1]
print(f"{start} - {end}")
' "$1" "$2"
}

booking_summary_has_time_range() {
  local expected_range="$1" source_response hierarchy
  source_response="$(api GET "/session/${SESSION_ID}/source" 2>/dev/null || true)"
  hierarchy="$(printf '%s' "$source_response" | json_value 'value')"
  printf '%s' "$hierarchy" | "${PYTHON_CMD[@]}" -c '
import sys
import xml.etree.ElementTree as ET

expected = sys.argv[1].lower()
data = sys.stdin.read()
start, end = data.find("<?xml"), data.rfind("</hierarchy>")
if start < 0 or end < 0:
    raise SystemExit(1)
try:
    root = ET.fromstring(data[start:end + len("</hierarchy>")])
except ET.ParseError:
    raise SystemExit(1)
for node in root.iter():
    for attribute in ("text", "content-desc"):
        value = node.attrib.get(attribute, "").lower()
        if f", {expected}, pickleball" in value:
            raise SystemExit(0)
raise SystemExit(1)
' "$expected_range"
}

wait_for_booking_time_range() {
  local expected_range="$1" deadline=$((SECONDS + BOOKING_TIMEOUT))
  while (( SECONDS < deadline )); do
    if booking_summary_has_time_range "$expected_range"; then
      return 0
    fi
    sleep "$ELEMENT_POLL_INTERVAL"
  done
  return 1
}

tap_time_slots_rapidly() {
  local slot_count="$1"
  shift
  local -a tap_arguments=("$@")
  local index slot range_start coordinates x y response error_message expected_range
  range_start="${tap_arguments[0]}"
  for ((index = 0; index < slot_count; index++)); do
    slot="${tap_arguments[index]}"
    coordinates="${tap_arguments[slot_count + index]}"
    x="${coordinates%%,*}"
    y="${coordinates#*,}"
    response="$(api POST "/session/${SESSION_ID}/execute/sync" \
      "{\"script\":\"mobile: clickGesture\",\"args\":[{\"x\":${x},\"y\":${y}}]}")"
    error_message="$(printf '%s' "$response" | json_value 'value.message')"
    [[ -z "$error_message" ]] || die "A rapid time-slot click failed at (${x},${y}): ${error_message}"
    expected_range="$(expected_time_range_from_slots "$range_start" "$slot")"
    wait_for_booking_time_range "$expected_range" || \
      die "Time slot ${slot} was clicked, but the booking summary did not update to ${expected_range}"
  done
}

booking_target_date_label() {
  local emulator_date=""
  local -a adb_args=()
  [[ -n "${UDID:-}" ]] && adb_args=(-s "$UDID")
  if command_exists adb; then
    emulator_date="$(adb "${adb_args[@]}" shell date +%Y-%m-%d 2>/dev/null | tr -d '\r')"
  fi
  printf '%s' "$emulator_date" | "${PYTHON_CMD[@]}" -c '
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
  "${PYTHON_CMD[@]}" -c '
import re, sys, xml.etree.ElementTree as ET
data = sys.stdin.read()
start, end = data.find("<?xml"), data.find("</hierarchy>")
if start < 0 or end < 0:
    raise SystemExit
try:
    root = ET.fromstring(data[start:end + len("</hierarchy>")])
except ET.ParseError:
    raise SystemExit
for node in root.iter():
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

court_strip_snapshot() {
  local source_response hierarchy
  source_response="$(api GET "/session/${SESSION_ID}/source" 2>/dev/null || true)"
  hierarchy="$(printf '%s' "$source_response" | json_value 'value')"
  printf '%s' "$hierarchy" | "${PYTHON_CMD[@]}" -c '
import re
import sys
import xml.etree.ElementTree as ET

data = sys.stdin.read()
start, end = data.find("<?xml"), data.rfind("</hierarchy>")
if start < 0 or end < 0:
    raise SystemExit
try:
    root = ET.fromstring(data[start:end + len("</hierarchy>")])
except ET.ParseError:
    raise SystemExit

nodes = list(root.iter())
parents = {child: parent for parent in nodes for child in parent}

def is_horizontal_scroll(node):
    return (node.attrib.get("class") == "android.widget.HorizontalScrollView" or
            str(node.tag).endswith("HorizontalScrollView"))

def node_label(node):
    return (node.attrib.get("text", "") or node.attrib.get("content-desc", "")).strip()

court_strip = None
select_detail = next((node for node in nodes if node_label(node).lower() == "select detail"), None)
ancestor = parents.get(select_detail) if select_detail is not None else None
while ancestor is not None and court_strip is None:
    court_strip = next((node for node in ancestor.iter() if is_horizontal_scroll(node)), None)
    ancestor = parents.get(ancestor)

if court_strip is None:
    for candidate in nodes:
        if not is_horizontal_scroll(candidate):
            continue
        if any(re.fullmatch(r"PICKLEBALL\s+\d+", node_label(descendant), re.I)
               for descendant in candidate.iter()):
            court_strip = candidate
            break
if court_strip is None:
    raise SystemExit

strip_bounds = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", court_strip.attrib.get("bounds", ""))
if strip_bounds is None:
    raise SystemExit
_, strip_y1, _, strip_y2 = map(int, strip_bounds.groups())

courts = {}
for node in court_strip.iter():
    if node.attrib.get("displayed", "true").lower() == "false":
        continue
    number = None
    for attribute in ("content-desc", "text"):
        label = node.attrib.get(attribute, "").strip()
        match = re.fullmatch(r"PICKLEBALL\s+(\d+)", label, re.I)
        if match is None:
            match = re.search(r",\s*Pickleball\s+(\d+)\s*$", label, re.I)
        if match is not None:
            number = int(match.group(1))
            break
    if number is None:
        continue
    bounds = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", node.attrib.get("bounds", ""))
    if bounds is None:
        continue
    x1, y1, x2, y2 = map(int, bounds.groups())
    courts.setdefault(number, ((x1 + x2) // 2, (y1 + y2) // 2))

if courts:
    ordered = sorted(courts.items(), key=lambda item: item[1][0])
    y = (strip_y1 + strip_y2) // 2
    print(str(y) + "\t" + ",".join(f"{number}:{position[0]}" for number, position in ordered))
'
}

swipe_court_strip() {
  local direction="$1"
  local snapshot="$2"
  local rect_response screen_width screen_height y start_x end_x
  rect_response="$(api GET "/session/${SESSION_ID}/window/rect")"
  screen_width="$(printf '%s' "$rect_response" | json_value 'value.width')"
  screen_height="$(printf '%s' "$rect_response" | json_value 'value.height')"
  y="${snapshot%%$'\t'*}"
  [[ "$screen_width" =~ ^[0-9]+$ && "$screen_height" =~ ^[0-9]+$ && "$y" =~ ^[0-9]+$ ]] || \
    die "Could not determine the court carousel position"

  if [[ "$direction" == "right" ]]; then
    start_x=$((screen_width * 35 / 100))
    end_x=$((screen_width * 90 / 100))
  else
    start_x=$((screen_width * 85 / 100))
    end_x=$((screen_width * 15 / 100))
  fi
  (( y >= screen_height )) && y=$((screen_height * 3 / 4))

  api POST "/session/${SESSION_ID}/actions" "{
    \"actions\":[{
      \"type\":\"pointer\",
      \"id\":\"court-strip-finger\",
      \"parameters\":{\"pointerType\":\"touch\"},
      \"actions\":[
        {\"type\":\"pointerMove\",\"duration\":0,\"x\":${start_x},\"y\":${y}},
        {\"type\":\"pointerDown\",\"button\":0},
        {\"type\":\"pause\",\"duration\":8},
        {\"type\":\"pointerMove\",\"duration\":100,\"x\":${end_x},\"y\":${y}},
        {\"type\":\"pointerUp\",\"button\":0}
      ]
    }]
  }" >/dev/null
  api DELETE "/session/${SESSION_ID}/actions" >/dev/null 2>&1 || true
}

find_court_carousel_element() {
  local carousel_element
  carousel_element="$(find_any_candidate_once \
    'xpath' '//*[@text="Select detail" or @content-desc="Select detail"]/following::android.widget.HorizontalScrollView[1]' \
    'xpath' '//android.widget.HorizontalScrollView[.//*[starts-with(@content-desc,"PICKLEBALL ")]]' \
    2>/dev/null || true)"
  [[ -n "$carousel_element" ]] || return 1
  printf '%s' "$carousel_element"
}

scroll_court_carousel_element() {
  local carousel_element="$1" direction="$2" response can_scroll_more error_message
  response="$(api POST "/session/${SESSION_ID}/execute/sync" \
    "{\"script\":\"mobile: scrollGesture\",\"args\":[{\"elementId\":$(printf '%s' "$carousel_element" | json_quote),\"direction\":\"${direction}\",\"percent\":1.0,\"speed\":10000}]}")"
  error_message="$(printf '%s' "$response" | json_value 'value.message')"
  [[ -z "$error_message" ]] || die "Could not scroll the court carousel ${direction}: ${error_message}"
  can_scroll_more="$(printf '%s' "$response" | json_value 'value')"
  [[ "$can_scroll_more" == "true" || "$can_scroll_more" == "false" ]] || \
    die "Court carousel returned an unexpected scroll result: ${response}"
  printf '%s' "$can_scroll_more"
}

reset_court_strip_to_beginning() {
  local carousel_element can_scroll_more attempt
  carousel_element="$(find_court_carousel_element)" || die "Could not find the horizontal court carousel"
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
    can_scroll_more="$(scroll_court_carousel_element "$carousel_element" right)"
    if [[ "$can_scroll_more" == "false" ]]; then
      return 0
    fi
  done
  die "Court carousel did not reach its beginning after 12 swipes"
}

wait_for_selected_court() {
  local expected_court="$1"
  local deadline=$((SECONDS + BOOKING_TIMEOUT)) selected_court
  while (( SECONDS < deadline )); do
    selected_court="$(current_selected_court)"
    if [[ "$selected_court" == "$expected_court" ]]; then
      return 0
    fi
    sleep "$ELEMENT_POLL_INTERVAL"
  done
  return 1
}

click_visible_court_and_confirm() {
  local court="$1" court_label="PICKLEBALL $1" court_element
  if court_element="$(find_element_once 'accessibility id' "$court_label" 2>/dev/null)"; then
    :
  elif court_element="$(find_element_once 'xpath' \
    "//*[@text=\"${court_label}\" or @content-desc=\"${court_label}\"]" 2>/dev/null)"; then
    :
  else
    return 1
  fi

  click_element "$court_element"
  wait_for_selected_court "$court" || \
    die "Court ${court} was clicked, but the selected-court summary did not update"
  printf 'Selected court %s.\n' "$court"
}

select_preferred_court() {
  local announce_unavailable="${1:-1}"
  local court_index court selected_court desired_court desired_index
  local snapshot next_snapshot entries entry visible_court seen_courts="" chosen_court="" chosen_index=-1 attempt
  local carousel_element can_scroll_more
  local -a visible_entries=()
  selected_court="$(current_selected_court)"
  if [[ -n "$selected_court" && "$announce_unavailable" == "1" ]]; then
    printf 'Court %s is currently selected.\n' "$selected_court"
  fi

  desired_index="$COURT_PRIORITY_START_INDEX"
  desired_court="${COURT_PRIORITY[desired_index]}"
  if [[ "$selected_court" == "$desired_court" ]]; then
    CURRENT_BOOKING_COURT_INDEX="$desired_index"
    CURRENT_BOOKING_COURT="$desired_court"
    printf 'Highest-priority court %s is already selected; no carousel scan is needed.\n' "$desired_court"
    return 0
  fi

  printf 'Rapidly searching the court carousel for highest-priority court %s...\n' "$desired_court"
  reset_court_strip_to_beginning
  CURRENT_BOOKING_COURT_INDEX="$desired_index"
  CURRENT_BOOKING_COURT="$desired_court"
  if click_visible_court_and_confirm "$desired_court"; then
    return 0
  fi

  carousel_element="$(find_court_carousel_element)" || die "Could not find the horizontal court carousel"
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
    can_scroll_more="$(scroll_court_carousel_element "$carousel_element" left)"
    if click_visible_court_and_confirm "$desired_court"; then
      printf 'Court %s was clicked immediately when it became visible.\n' "$desired_court"
      return 0
    fi
    [[ "$can_scroll_more" == "false" ]] && break
  done

  printf 'Court %s was not present; scanning once for the best lower-priority court.\n' "$desired_court"
  reset_court_strip_to_beginning
  snapshot="$(court_strip_snapshot)"
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    [[ -n "$snapshot" ]] || die "Lost the court carousel while scanning it"
    entries="${snapshot#*$'\t'}"
    IFS=',' read -r -a visible_entries <<< "$entries"
    for entry in "${visible_entries[@]}"; do
      visible_court="${entry%%:*}"
      if [[ "$visible_court" =~ ^[0-9]+$ && $'\n'"$seen_courts"$'\n' != *$'\n'"$visible_court"$'\n'* ]]; then
        seen_courts+="${visible_court}"$'\n'
      fi
    done

    if [[ $'\n'"$seen_courts"$'\n' == *$'\n'"$desired_court"$'\n'* ]]; then
      CURRENT_BOOKING_COURT_INDEX="$desired_index"
      CURRENT_BOOKING_COURT="$desired_court"
      printf 'Court %s became visible; clicking it immediately.\n' "$desired_court"
      click_visible_court_and_confirm "$desired_court" || \
        die "Court ${desired_court} became visible but its clickable element could not be found"
      return 0
    fi

    swipe_court_strip left "$snapshot"
    next_snapshot="$(court_strip_snapshot)"
    [[ "$next_snapshot" == "$snapshot" ]] && break
    snapshot="$next_snapshot"
  done

  for ((court_index = COURT_PRIORITY_START_INDEX; court_index < ${#COURT_PRIORITY[@]}; court_index++)); do
    court="${COURT_PRIORITY[court_index]}"
    if [[ $'\n'"$seen_courts"$'\n' == *$'\n'"$court"$'\n'* ]]; then
      chosen_court="$court"
      chosen_index="$court_index"
      break
    fi
    [[ "$announce_unavailable" == "1" ]] && \
      printf 'Court %s is unavailable; trying the next preference.\n' "$court"
  done
  if [[ -z "$chosen_court" ]]; then
    [[ "$announce_unavailable" == "1" ]] && \
      printf 'None of the preferred courts are currently available. No reservation was submitted.\n'
    return 1
  fi

  CURRENT_BOOKING_COURT_INDEX="$chosen_index"
  CURRENT_BOOKING_COURT="$chosen_court"
  if [[ "$chosen_court" == "$selected_court" ]]; then
    printf 'Highest-priority available court %s is already selected; no click is needed.\n' "$chosen_court"
    return 0
  fi

  printf 'Highest-priority available court across the full carousel is %s.\n' "$chosen_court"
  reset_court_strip_to_beginning
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    if click_visible_court_and_confirm "$chosen_court"; then
      return 0
    fi
    snapshot="$(court_strip_snapshot)"
    [[ -n "$snapshot" ]] || break
    swipe_court_strip left "$snapshot"
    next_snapshot="$(court_strip_snapshot)"
    [[ "$next_snapshot" == "$snapshot" ]] && break
  done
  die "Court ${chosen_court} was found during the full scan but could not be selected"
}

click_court_selection_next() {
  printf 'Clicking Next after court selection...\n'
  click_first_candidate "$BOOKING_TIMEOUT" 'court selection Next button' \
    'xpath' '//*[@text="NEXT" or starts-with(@content-desc,"NEXT")]' \
    'accessibility id' 'NEXT'
  printf 'Advanced past court selection.\n'
}

click_top_left_back() {
  click_first_candidate "$BOOKING_TIMEOUT" 'top-left Back button' \
    'accessibility id' 'Back' \
    'accessibility id' 'BACK' \
    'accessibility id' 'Navigate up' \
    'xpath' '//*[@text="Back" or @text="BACK" or @content-desc="Back" or @content-desc="BACK" or @content-desc="Navigate up"]'
}

record_booking_failure_popup() {
  local popup_text="$1"
  [[ -n "$popup_text" ]] || popup_text='Booking was rejected, but the popup contained no readable message.'
  mkdir -p "$(dirname "$BOOKING_FAILURE_FILE")"
  printf '%s\n' "$popup_text" >"$BOOKING_FAILURE_FILE"
  printf 'Booking popup text: %s\n' "$popup_text"
  printf 'Saved booking popup text to %s\n' "$BOOKING_FAILURE_FILE"
}

handle_booking_failure_popup() {
  local hierarchy="$1"
  local alert_response alert_text ok_element popup_text

  alert_response="$(api GET "/session/${SESSION_ID}/alert/text" 2>/dev/null || true)"
  alert_text="$(printf '%s' "$alert_response" | "${PYTHON_CMD[@]}" -c '
import json
import sys
try:
    value = json.load(sys.stdin).get("value")
except (AttributeError, json.JSONDecodeError):
    raise SystemExit
if isinstance(value, str):
    print(value)
')"
  if [[ -n "$alert_text" ]]; then
    record_booking_failure_popup "$alert_text"
    if ! api POST "/session/${SESSION_ID}/alert/accept" '{}' >/dev/null 2>&1; then
      ok_element="$(find_with_candidates "$BOOKING_TIMEOUT" 'booking popup OK button' \
        'id' 'android:id/button1' \
        'accessibility id' 'OK' \
        'accessibility id' 'Ok' \
        'xpath' '//*[translate(@text,"abcdefghijklmnopqrstuvwxyz","ABCDEFGHIJKLMNOPQRSTUVWXYZ")="OK" or translate(@content-desc,"abcdefghijklmnopqrstuvwxyz","ABCDEFGHIJKLMNOPQRSTUVWXYZ")="OK"]')"
      click_element "$ok_element"
    fi
  else
    ok_element="$(find_any_candidate_once \
      'id' 'android:id/button1' \
      'accessibility id' 'OK' \
      'accessibility id' 'Ok' \
      'xpath' '//*[translate(@text,"abcdefghijklmnopqrstuvwxyz","ABCDEFGHIJKLMNOPQRSTUVWXYZ")="OK" or translate(@content-desc,"abcdefghijklmnopqrstuvwxyz","ABCDEFGHIJKLMNOPQRSTUVWXYZ")="OK"]' 2>/dev/null || true)"
    [[ -n "$ok_element" ]] || return 1
    popup_text="$(printf '%s' "$hierarchy" | "${PYTHON_CMD[@]}" -c '
import sys
import xml.etree.ElementTree as ET

data = sys.stdin.read()
start, end = data.find("<?xml"), data.rfind("</hierarchy>")
if start < 0 or end < 0:
    raise SystemExit
try:
    root = ET.fromstring(data[start:end + len("</hierarchy>")])
except ET.ParseError:
    raise SystemExit

nodes = list(root.iter())
parents = {child: parent for parent in nodes for child in parent}
values = []
preferred = []
for node in nodes:
    resource_id = node.attrib.get("resource-id", "").lower()
    for attribute in ("text", "content-desc"):
        value = node.attrib.get(attribute, "").strip()
        if not value or value.upper() in {"OK", "BACK", "BOOK", "NEXT"}:
            continue
        if value not in values:
            values.append(value)
        if resource_id.endswith(":id/message") or resource_id.endswith("/message") or "alerttitle" in resource_id:
            if value not in preferred:
                preferred.append(value)

def meaningful_values(node):
    found = []
    for descendant in node.iter():
        for attribute in ("text", "content-desc"):
            value = descendant.attrib.get(attribute, "").strip()
            if value and value.upper() not in {"OK", "BACK", "BOOK", "NEXT"} and len(value) >= 4 and value not in found:
                found.append(value)
    return found

candidates = []
for ok_node in nodes:
    labels = {ok_node.attrib.get("text", "").strip().upper(), ok_node.attrib.get("content-desc", "").strip().upper()}
    if "OK" not in labels:
        continue
    ancestor = parents.get(ok_node)
    while ancestor is not None:
        candidates = meaningful_values(ancestor)
        if candidates:
            break
        ancestor = parents.get(ancestor)
    if candidates:
        break

candidates = preferred or candidates or [value for value in values if len(value) >= 12]
if candidates:
    print(max(candidates, key=len))
')"
    record_booking_failure_popup "$popup_text"
    click_element "$ok_element"
  fi

  printf 'Clicking the top-left Back button twice to return to court selection...\n'
  click_top_left_back || die "Could not find the first top-left Back button after dismissing the booking popup"
  click_top_left_back || die "Could not find the second top-left Back button while returning to court selection"
  return 0
}

dismiss_maybe_later_prompt_once() {
  local maybe_later_element
  maybe_later_element="$(find_any_candidate_once \
    'accessibility id' 'Maybe Later' \
    'accessibility id' 'Maybe later' \
    'xpath' '//*[translate(@text,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz")="maybe later" or translate(@content-desc,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz")="maybe later"]' \
    2>/dev/null || true)"
  [[ -n "$maybe_later_element" ]] || return 1
  click_element "$maybe_later_element"
  printf 'Dismissed the post-Book prompt with Maybe Later.\n'
  return 0
}

wait_for_confirmation_number() {
  local deadline=$((SECONDS + CONFIRMATION_TIMEOUT))
  local source_response hierarchy confirmation_number

  printf 'Waiting for the booking confirmation number...\n'
  while (( SECONDS < deadline )); do
    if dismiss_maybe_later_prompt_once; then
      continue
    fi
    source_response="$(api GET "/session/${SESSION_ID}/source" 2>/dev/null || true)"
    hierarchy="$(printf '%s' "$source_response" | json_value 'value')"
    confirmation_number="$(printf '%s' "$hierarchy" | "${PYTHON_CMD[@]}" -c '
import re
import sys
import xml.etree.ElementTree as ET

data = sys.stdin.read()
start, end = data.find("<?xml"), data.rfind("</hierarchy>")
if start < 0 or end < 0:
    raise SystemExit
try:
    root = ET.fromstring(data[start:end + len("</hierarchy>")])
except ET.ParseError:
    raise SystemExit

values = []
for node in root.iter():
    for attribute in ("text", "content-desc"):
        value = node.attrib.get(attribute, "").strip()
        if value and (not values or values[-1] != value):
            values.append(value)

patterns = (
    re.compile(r"confirmation\s*(?:number|no\.?)\s*(?:is\s*)?[:#-]?\s*([A-Z0-9][A-Z0-9-]{2,})", re.I),
    re.compile(r"confirmation\s*#\s*([A-Z0-9][A-Z0-9-]{2,})", re.I),
)
for value in values:
    for pattern in patterns:
        match = pattern.search(value)
        if match and any(character.isdigit() for character in match.group(1)):
            print(match.group(1))
            raise SystemExit

for index, value in enumerate(values):
    if "confirmation" not in value.lower():
        continue
    for candidate in values[index + 1:index + 4]:
        compact = candidate.strip()
        if re.fullmatch(r"[A-Z0-9][A-Z0-9-]{2,}", compact, re.I) and any(character.isdigit() for character in compact):
            print(compact)
            raise SystemExit
')"
    if [[ -n "$confirmation_number" ]]; then
      mkdir -p "$(dirname "$CONFIRMATION_FILE")"
      printf '%s\n' "$confirmation_number" >"$CONFIRMATION_FILE"
      printf 'Booking confirmation number: %s\n' "$confirmation_number"
      printf 'Saved confirmation number to %s\n' "$CONFIRMATION_FILE"
      return 0
    fi
    if handle_booking_failure_popup "$hierarchy"; then
      return 2
    fi
    sleep "$ELEMENT_POLL_INTERVAL"
  done

  die "Could not find either a confirmation number or a booking popup within ${CONFIRMATION_TIMEOUT}s after clicking Book"
}

submit_booking_after_players() {
  local next_element book_element

  printf 'Clicking Next after player selection...\n'
  next_element="$(find_with_candidates "$BOOKING_TIMEOUT" 'Next button after player selection' \
    'accessibility id' 'Next' \
    'accessibility id' 'NEXT' \
    'xpath' '//*[@text="Next" or @text="NEXT" or @content-desc="Next" or @content-desc="NEXT"]')"
  click_element "$next_element"

  printf 'Clicking Book after the final Next...\n'
  book_element="$(find_with_candidates "$BOOKING_TIMEOUT" 'final Book button' \
    'accessibility id' 'Book' \
    'accessibility id' 'BOOK' \
    'xpath' '//*[@text="Book" or @text="BOOK" or @content-desc="Book" or @content-desc="BOOK"]')"
  click_element "$book_element"
  wait_for_confirmation_number
}

add_additional_player() {
  if [[ -z "$ADDITIONAL_PLAYER_NAME" ]]; then
    printf 'No additional player is configured; skipping Add Players.\n'
    submit_booking_after_players
    return $?
  fi

  local player_name_xpath add_players_element find_players_element player_element add_element done_element
  player_name_xpath="$(xpath_literal "$ADDITIONAL_PLAYER_NAME")"

  if find_element_once 'xpath' \
    "//*[@text=${player_name_xpath} or @content-desc=${player_name_xpath}]" >/dev/null 2>&1; then
    printf 'Additional player %s is already selected; skipping Add Player.\n' "$ADDITIONAL_PLAYER_NAME"
    submit_booking_after_players
    return $?
  fi

  printf 'Opening Add Player...\n'
  add_players_element="$(find_with_candidates "$BOOKING_TIMEOUT" 'Add Player button' \
    'accessibility id' 'Add Players' \
    'accessibility id' 'Add players' \
    'accessibility id' 'ADD PLAYERS' \
    'accessibility id' 'Add Player' \
    'accessibility id' 'Add player' \
    'accessibility id' 'ADD PLAYER' \
    'xpath' '//*[(translate(@text,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz")="add player" or translate(@text,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz")="add players") or (translate(@content-desc,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz")="add player" or translate(@content-desc,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz")="add players")]')"
  click_element "$add_players_element"

  printf 'Searching for additional player: %s...\n' "$ADDITIONAL_PLAYER_NAME"
  find_players_element="$(find_with_candidates "$BOOKING_TIMEOUT" 'Find players field' \
    'accessibility id' 'Find players' \
    'xpath' '//android.widget.EditText[@text="Find players" or @content-desc="Find players"]' \
    'xpath' '//android.widget.EditText[contains(translate(@text,"FIND PLAYERS","find players"),"find players")]')"
  type_into "$find_players_element" "$ADDITIONAL_PLAYER_NAME"

  player_element="$(find_with_candidates "$BOOKING_TIMEOUT" 'matching additional player' \
    'accessibility id' "$ADDITIONAL_PLAYER_NAME" \
    'xpath' "//*[@text=${player_name_xpath} or @content-desc=${player_name_xpath}]" \
    'xpath' "//*[contains(@text,${player_name_xpath}) or contains(@content-desc,${player_name_xpath})]")"
  [[ -n "$player_element" ]] || die "Could not verify additional player '${ADDITIONAL_PLAYER_NAME}' in search results"

  printf 'Adding player: %s...\n' "$ADDITIONAL_PLAYER_NAME"
  add_element="$(find_with_candidates "$BOOKING_TIMEOUT" "Add button for ${ADDITIONAL_PLAYER_NAME}" \
    'xpath' "//*[@text=${player_name_xpath} or @content-desc=${player_name_xpath}]/following::*[@text=\"Add\" or @content-desc=\"Add\"][1]" \
    'xpath' "//*[contains(@text,${player_name_xpath}) or contains(@content-desc,${player_name_xpath})]/following::*[@text=\"Add\" or @content-desc=\"Add\"][1]" \
    'xpath' "//*[contains(@content-desc,${player_name_xpath}) and (contains(@content-desc,\"Add\") or contains(@content-desc,\"ADD\"))]" \
    'accessibility id' 'Add' \
    'accessibility id' 'ADD' \
    'xpath' '//*[@text="Add" or @text="ADD" or @content-desc="Add" or @content-desc="ADD"]')"
  click_element "$add_element"
  printf 'Added player: %s.\n' "$ADDITIONAL_PLAYER_NAME"

  printf 'Clicking Done after adding the player...\n'
  done_element="$(find_with_candidates "$BOOKING_TIMEOUT" 'top-right Done button' \
    'accessibility id' 'Done' \
    'accessibility id' 'DONE' \
    'xpath' '//*[@text="Done" or @text="DONE" or @content-desc="Done" or @content-desc="DONE"]')"
  click_element "$done_element"
  submit_booking_after_players
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
  # Establish a deterministic starting position with one continuous fling
  # before trying to select the target.
  printf 'Swiping the date strip all the way to the right in one motion...\n'
  swipe_date_strip_all_the_way_right

  # Only after the full reset, move forward until day +7 is visible.
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
    if target_element="$(find_element_once 'accessibility id' "$target_label" 2>/dev/null)"; then
      click_element "$target_element"
      printf 'Selected booking date: %s.\n' "$target_label"
      break
    fi
    swipe_date_strip_left
  done
  [[ -n "$target_element" ]] || die "Could not find booking date '${target_label}' after scrolling the date strip"

  wait_for_time_slot_availability
  # Only move after the countdown has been replaced by the available slots.
  scroll_booking_to_bottom

  local slot slot_element selection_plan status x y
  local -a rapid_slot_labels=() rapid_slot_coordinates=()
  local selected_slot_count=0 use_legacy_slot_selection=0 first_slot_unavailable=0
  local booked_slot=""
  selection_plan="$(plan_time_slot_selection)"
  if [[ -n "$selection_plan" ]]; then
    while IFS=$'\t' read -r status slot x y; do
      case "$status" in
        available)
          rapid_slot_labels+=("$slot")
          rapid_slot_coordinates+=("$x,$y")
          ;;
        booked)
          if [[ "$slot" == "${BOOKING_TIME_SLOTS[0]}" ]]; then
            first_slot_unavailable=1
            printf 'First time slot %s is already booked (red status); skipping it and attempting the remaining slots.\n' "$slot"
            continue
          fi
          booked_slot="$slot"
          printf 'Time slot %s is already booked (red status); leaving it untouched and stopping slot selection.\n' "$slot"
          break
          ;;
        missing)
          if [[ "$slot" == "${BOOKING_TIME_SLOTS[0]}" ]]; then
            first_slot_unavailable=1
            printf 'First time slot %s is unavailable; skipping it and attempting the remaining slots.\n' "$slot"
            continue
          fi
          printf 'Fast slot plan could not map %s; using accessibility-ID clicks instead.\n' "$slot"
          use_legacy_slot_selection=1
          rapid_slot_labels=()
          rapid_slot_coordinates=()
          break
          ;;
      esac
    done <<< "$selection_plan"

    if (( use_legacy_slot_selection == 0 && ${#rapid_slot_coordinates[@]} > 0 )); then
      printf 'Rapidly selecting time slots with validated clicks: %s...\n' "${rapid_slot_labels[*]}"
      tap_time_slots_rapidly "${#rapid_slot_labels[@]}" \
        "${rapid_slot_labels[@]}" "${rapid_slot_coordinates[@]}"
      selected_slot_count=${#rapid_slot_coordinates[@]}
    fi
  else
    use_legacy_slot_selection=1
  fi

  if (( use_legacy_slot_selection == 1 )); then
    printf 'Fast slot plan was unavailable; falling back to individual element clicks.\n'
    for slot in "${BOOKING_TIME_SLOTS[@]}"; do
      if slot_element="$(find_element_once 'accessibility id' "$slot" 2>/dev/null)"; then
        click_element "$slot_element"
        selected_slot_count=$((selected_slot_count + 1))
        continue
      fi
      if find_element_once 'xpath' \
        "//*[starts-with(@content-desc,\"${slot},\")]" >/dev/null 2>&1; then
        if [[ "$slot" == "${BOOKING_TIME_SLOTS[0]}" ]]; then
          first_slot_unavailable=1
          printf 'First time slot %s is already booked (red status); skipping it and attempting the remaining slots.\n' "$slot"
          continue
        fi
        booked_slot="$slot"
        printf 'Time slot %s is already booked (red status); leaving it untouched and stopping slot selection.\n' "$slot"
        break
      fi
      if [[ "$slot" == "${BOOKING_TIME_SLOTS[0]}" ]]; then
        first_slot_unavailable=1
        printf 'First time slot %s is unavailable; skipping it and attempting the remaining slots.\n' "$slot"
        continue
      fi
      booked_slot="$slot"
      printf 'Time slot %s is not selectable; leaving it untouched and continuing to court selection.\n' "$slot"
      break
    done
  fi
  if (( first_slot_unavailable == 1 )) && [[ -n "$booked_slot" ]]; then
    printf 'Selected %s available slot(s) after skipping the first slot and before %s became unavailable.\n' \
      "$selected_slot_count" "$booked_slot"
  elif (( first_slot_unavailable == 1 )); then
    printf 'Selected %s remaining configured time slots after skipping the unavailable first slot.\n' \
      "$selected_slot_count"
  elif [[ -n "$booked_slot" ]]; then
    printf 'Selected %s available slot(s) before the booked slot.\n' \
      "$selected_slot_count"
  else
    printf 'Selected all %s configured time slots.\n' \
      "$selected_slot_count"
  fi

  printf 'Bringing court selection into view...\n'
  scroll_booking_details_into_view
  local booking_result is_court_retry=0
  while (( COURT_PRIORITY_START_INDEX < ${#COURT_PRIORITY[@]} )); do
    if ! select_preferred_court 1; then
      printf 'Court preference handling completed without a selection. No reservation was submitted.\n'
      return 0
    fi

    click_court_selection_next
    if (( is_court_retry == 1 )); then
      printf 'Court retry: preserving the existing player selection and skipping Add Player.\n'
      if submit_booking_after_players; then
        return 0
      else
        booking_result=$?
      fi
    else
      if add_additional_player; then
        return 0
      else
        booking_result=$?
      fi
    fi

    [[ "$booking_result" == "2" ]] || return "$booking_result"
    COURT_PRIORITY_START_INDEX=$((CURRENT_BOOKING_COURT_INDEX + 1))
    if (( COURT_PRIORITY_START_INDEX >= ${#COURT_PRIORITY[@]} )); then
      die "Booking was rejected for court ${CURRENT_BOOKING_COURT}, and no lower-priority courts remain"
    fi
    is_court_retry=1
    printf 'Booking was rejected for court %s; retrying with the next court in the priority array (%s).\n' \
      "$CURRENT_BOOKING_COURT" "${COURT_PRIORITY[COURT_PRIORITY_START_INDEX]}"
  done
}

main() {
  [[ "${1:-}" != "-h" && "${1:-}" != "--help" ]] || { usage; exit 0; }
  [[ $# -eq 0 ]] || { usage >&2; die "Unexpected arguments"; }
  command_exists curl || die "curl is required"
  if [[ -n "${PLAYBYPOINT_PYTHON:-}" && -x "${PLAYBYPOINT_PYTHON}" ]]; then
    PYTHON_CMD=("${PLAYBYPOINT_PYTHON}")
  elif command_exists python3; then
    PYTHON_CMD=(python3)
  elif command_exists python; then
    PYTHON_CMD=(python)
  elif command_exists py; then
    PYTHON_CMD=(py -3)
  else
    die "Python 3 is required"
  fi
  "${PYTHON_CMD[@]}" -c 'import sys; raise SystemExit(0 if sys.version_info.major == 3 else 1)' || \
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
    mkdir -p "$(dirname "$APPIUM_LOG")"
    printf 'Starting Appium (log: %s)...\n' "$APPIUM_LOG"
    appium >"$APPIUM_LOG" 2>&1 &
    APPIUM_PID=$!
    local appium_deadline=$((SECONDS + APPIUM_START_TIMEOUT))
    while (( SECONDS < appium_deadline )); do
      if server_is_ready; then
        break
      fi
      if ! kill -0 "$APPIUM_PID" >/dev/null 2>&1; then
        printf 'Appium exited during startup. Recent log output:\n' >&2
        tail -n 40 "$APPIUM_LOG" >&2 || true
        die "Appium process terminated; inspect ${APPIUM_LOG}"
      fi
      sleep "$ELEMENT_POLL_INTERVAL"
    done
    if ! server_is_ready; then
      printf 'Appium did not become ready. Recent log output:\n' >&2
      tail -n 40 "$APPIUM_LOG" >&2 || true
      die "Appium did not become ready within ${APPIUM_START_TIMEOUT}s; inspect ${APPIUM_LOG}"
    fi
    printf 'Appium is ready.\n'
  fi

  local automation app_id platform_name platform_capabilities udid_capabilities session_payload response
  if [[ "$PLATFORM" == "android" ]]; then
    automation="UiAutomator2"
    app_id="$ANDROID_PACKAGE"
    platform_name="Android"
    platform_capabilities=',"appium:autoGrantPermissions":false,"appium:disableWindowAnimation":true,"appium:settings[enableMultiWindows]":true,"appium:settings[waitForIdleTimeout]":0,"appium:settings[waitForSelectorTimeout]":0'
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
    sleep "$ELEMENT_POLL_INTERVAL"
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
      sleep "$ELEMENT_POLL_INTERVAL"
    done
    die "Login was submitted, but the sign-in form remained visible. Check the credentials or set SUCCESS_SELECTOR."
  fi

  printf 'Login completed and SUCCESS_SELECTOR was found.\n'
  run_booking_flow
}

main "$@"
