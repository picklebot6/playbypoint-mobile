#!/usr/bin/env bash
set -euo pipefail

adb shell wm user-rotation lock 1
adb shell wm size 1920x1080
adb shell wm density 160
adb shell am force-stop com.android.chrome

npx appium --log-level error --log-no-colors \
  --allow-insecure uiautomator2:chromedriver_autodownload > /tmp/active-bookings-appium.log 2>&1 &
appium_pid=$!
trap 'kill "$appium_pid" 2>/dev/null || true' EXIT

ready=false
for attempt in $(seq 1 30); do
  if ! kill -0 "$appium_pid" 2>/dev/null; then
    echo "Appium exited before it was ready."
    exit 1
  fi
  if curl --fail --silent --max-time 2 http://127.0.0.1:4723/status > /dev/null; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != "true" ]]; then
  echo "Appium did not become ready within 30 attempts."
  exit 1
fi

npm run bookings:active
