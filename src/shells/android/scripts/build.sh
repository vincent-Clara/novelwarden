#!/usr/bin/env bash
# 打 Android 包：獨立版打成 node 單檔案 → assets/server.cjs，Termux node → jniLibs（沒有才取），再 gradle assemble。
# 用法（任意目錄）：src/shells/android/scripts/build.sh [debug|release]，產物在 src/shells/android/app/build/outputs/apk/
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/../../.." && pwd)"
variant="${1:-debug}"
main="$here/app/src/main"

rm -rf "$main/assets"
mkdir -p "$main/assets"
(cd "$repo" && node scripts/build-android-server.js "$main/assets/server.cjs")

[[ -f "$main/jniLibs/arm64-v8a/libnode.so" ]] || "$here/scripts/fetch-node.sh"

cd "$here"
./gradlew --no-daemon -q --stacktrace "assemble${variant^}"
ls -l app/build/outputs/apk/"$variant"/*.apk
