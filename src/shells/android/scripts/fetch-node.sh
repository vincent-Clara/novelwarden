#!/usr/bin/env bash
# 取 Termux 的 nodejs-lts（arm64、bionic 編譯）及其依賴庫，放進 app/src/main/jniLibs/arm64-v8a，給內建服務端用。
# Android 10+ 只允許執行 nativeLibraryDir 裡的檔案，而安裝時只解壓名為 lib*.so 的檔案，所以：
#   - node 本體改名 libnode.so
#   - libssl.so.3 這類帶版本號的庫改名 libssl_3.so：等長改名，直接在 .dynstr 裡原地替換 soname 與 DT_NEEDED，不重寫 ELF 結構
# 包的下載地址與 sha256 取自 Termux 倉庫的 Packages 索引。
# 依賴：curl dpkg-deb readelf python3（GitHub 的 ubuntu runner 都有）
# 取自望舒（wangshu-reader）的同名指令碼，多了一道檢查：node 要的庫既不在這幾個包裡、也不是 Android 系統庫時直接失敗。
set -euo pipefail
repo=https://packages.termux.dev/apt/termux-main
pkgs=(nodejs-lts libc++ openssl c-ares libicu libsqlite zlib)
dest="$(cd "$(dirname "$0")/.." && pwd)/app/src/main/jniLibs/arm64-v8a"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

curl -fsSL "$repo/dists/stable/main/binary-aarch64/Packages" -o "$work/Packages"
for p in "${pkgs[@]}"; do
  read -r file sha < <(awk -v p="$p" 'BEGIN { RS = ""; FS = "\n" }
    { hit = 0; f = ""; s = ""
      for (i = 1; i <= NF; i++) {
        if ($i == "Package: " p) hit = 1
        if ($i ~ /^Filename: /) f = substr($i, 11)
        if ($i ~ /^SHA256: /) s = substr($i, 9)
      }
      if (hit) { print f, s; exit } }' "$work/Packages")
  [[ -n "${file:-}" ]] || { echo "Termux 倉庫裡找不到 $p" >&2; exit 1; }
  echo "· $file" >&2
  curl -fsSL "$repo/$file" -o "$work/pkg.deb"
  echo "$sha  $work/pkg.deb" | sha256sum -c --quiet
  dpkg-deb -x "$work/pkg.deb" "$work/root"
done

rm -rf "$dest"
mkdir -p "$dest"
python3 - "$work/root/data/data/com.termux/files/usr" "$dest" <<'EOF'
import re, shutil, subprocess, sys
from pathlib import Path

usr, dest = Path(sys.argv[1]), Path(sys.argv[2])

def needed(f):
    out = subprocess.run(['readelf', '-d', str(f)], capture_output=True, text=True, check=True).stdout
    return re.findall(r'\(NEEDED\)\s+Shared library: \[(.+?)\]', out)

# Android 系統自帶、app 程序裡就能連結到的庫（NDK 的穩定 API）。不在這裡、也不在 Termux 包裡的，裝上手機必然起不來
SYSTEM = {'libc.so', 'libm.so', 'libdl.so', 'liblog.so', 'libandroid.so'}

def rename(n):
    # libssl.so.3 → libssl_3.so（與原名等長）；本來就是 lib*.so 的不動
    m = re.fullmatch(r'(lib.+)\.so\.(.+)', n)
    return f'{m.group(1)}_{m.group(2)}.so' if m else n

mapping, files = {}, {}
todo = [(usr / 'bin' / 'node', 'libnode.so')]
while todo:
    src, name = todo.pop()
    if name in files:
        continue
    files[name] = src
    for n in needed(src):
        if (usr / 'lib' / n).exists():
            mapping[n] = rename(n)
            todo.append((usr / 'lib' / n, mapping[n]))
        elif n not in SYSTEM:
            sys.exit(f'{src.name} 要 {n}：不在取下來的 Termux 包裡，也不是系統庫——在指令碼開頭的 pkgs 裡補上它所在的包')

for name, src in files.items():
    data = bytearray(Path(src).resolve().read_bytes())
    for old, new in mapping.items():
        if old != new:
            assert len(old) == len(new)
            data = data.replace(b'\0' + old.encode() + b'\0', b'\0' + new.encode() + b'\0')
    (dest / name).write_bytes(data)
    print(f'  {name:28} {len(data) / 1e6:6.1f} MB', file=sys.stderr)
EOF
du -sh "$dest" >&2
