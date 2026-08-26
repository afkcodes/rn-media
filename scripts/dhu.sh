#!/usr/bin/env bash
# Open Google's Desktop Head Unit against the connected phone — the whole
# recipe, because three of its steps are undocumented (ARCHITECTURE §31):
#
#  1. `startupfocus = true` in ~/.android/headunit.ini, or the DHU connects and
#     draws nothing ("Don't have video focus"). No shipped sample .ini sets it.
#  2. A stale gearhead:car session holds the head-unit server: force-stop
#     Android Auto and restart the server before every connect.
#  3. The DHU exits the moment its stdin closes, so it is fed from a FIFO.
#
# Prerequisites (once): Android Auto developer mode (About → version ×10);
# `sdkmanager "extras;google;auto"`. Usage: scripts/dhu.sh [adb-serial]
set -euo pipefail
D="${1:-895e7ead}"
SDK="${ANDROID_HOME:-$HOME/Android/Sdk}"
INI="$HOME/.android/headunit.ini"
RUN="${TMPDIR:-/tmp}/rn-media-dhu"; mkdir -p "$RUN"

if ! grep -q '^startupfocus *= *true' "$INI" 2>/dev/null; then
  mkdir -p "$(dirname "$INI")"
  printf '[general]\ntouch = true\nresolution = 800x480\ndpi = 160\nframerate = 30\nstartupfocus = true\n\n[sensors]\nlocation = true\nnight_mode = true\ndriving_status = true\n' > "$INI"
  echo "wrote $INI (startupfocus = true)"
fi

tapText() {  # tap the first UI node whose XML contains $1
  adb -s "$D" shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
  local b; b=$(adb -s "$D" shell "cat /sdcard/ui.xml" 2>/dev/null | tr '>' '\n' | grep -F "$1" \
    | grep -oE 'bounds="\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]"' | head -1 | grep -oE '[0-9]+')
  local a=($b); [ ${#a[@]} -lt 4 ] && { echo "not on screen: $1"; return 1; }
  adb -s "$D" shell input tap $(( (a[0] + a[2]) / 2 )) $(( (a[1] + a[3]) / 2 ))
}

pkill -x desktop-head-unit 2>/dev/null || true
adb -s "$D" shell am force-stop com.google.android.projection.gearhead
adb -s "$D" shell input keyevent KEYCODE_WAKEUP >/dev/null
adb -s "$D" shell am start -n com.google.android.projection.gearhead/.companion.settings.DefaultSettingsActivity >/dev/null
sleep 4
tapText 'content-desc="More options"'; sleep 2
tapText 'text="Start head unit server"' || { echo "enable Android Auto developer mode first (About → version ×10)"; exit 1; }
sleep 4
adb -s "$D" forward tcp:5277 tcp:5277 >/dev/null

rm -f "$RUN/stdin"; mkfifo "$RUN/stdin"
( exec 3>"$RUN/stdin"; sleep 1000000 ) &   # hold the DHU's stdin open
cd "$SDK/extras/google/auto"
echo "DHU starting (log: $RUN/dhu.log). Type commands into $RUN/stdin, e.g.: echo screenshot > $RUN/stdin"
exec ./desktop-head-unit -a 5277 < "$RUN/stdin" > "$RUN/dhu.log" 2>&1
