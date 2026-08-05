# Oracle Ampere A1 deployment

This project runs on an Oracle A1 ARM64 VM by using an ARM64 ReDroid Android
container instead of Google's desktop Android Emulator. ReDroid exposes Android
to Appium through ADB on `127.0.0.1:5555` and persists Android data under
`.redroid-data/`.

## Host prerequisites

Use Ubuntu ARM64 and install Docker, an ARM64 JDK 17+, Node.js 22+, Android SDK
Platform-Tools, and the Android Binder kernel module required by ReDroid. Follow
the ReDroid deployment instructions for the VM's exact Ubuntu/kernel version.
Do not expose port 5555 publicly.

After copying this project to the VM:

```bash
npm ci
export APPIUM_HOME="$PWD/.appium"
npx appium driver install uiautomator2
chmod 600 scripts/playbypoint-credentials.local.sh
```

Put the ARM64 Playbypoint APK in a private directory. If the application was
distributed as split APKs, put every split from the same installed version in
one directory. On the first run, point `PLAYBYPOINT_APK` to the file or folder:

```bash
PLAYBYPOINT_APK="$HOME/private/playbypoint-apks" \
  ./scripts/playbypoint-oracle-a1-session.sh
```

Later runs do not need `PLAYBYPOINT_APK`; the ReDroid data directory preserves
the installed application and its login state.

If ReDroid fails to boot, check:

```bash
sudo modprobe binder_linux devices="binder,hwbinder,vndbinder"
docker logs playbypoint-android
```

ReDroid's base image does not include a certified Google Play Store. Playbypoint
must therefore work when sideloaded, and any Play Integrity or required Google
Mobile Services dependency must be tested before scheduling unattended runs.
