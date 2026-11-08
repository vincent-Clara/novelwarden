# syntax=docker/dockerfile:1
#
# 獨立版 Web 服務的映象：部署到伺服器，從別的機器用瀏覽器訪問。
#
# 構建：docker buildx build --platform linux/amd64,linux/arm64 .（CI 見 .github/workflows/docker.yml）
# 執行：見 README「Docker 部署」。必須給 NOVELWARDEN_TOKEN（舊名 NOVELFORGE_TOKEN 仍相容）——映象裡綁 0.0.0.0，沒令牌服務拒絕啟動。
#
# 兩段：
# 1) 構建段**固定跑在構建機的架構上**（--platform=$BUILDPLATFORM），由 Bun 交叉編譯出目標架構的
#    單檔案可執行。編譯不經 QEMU 模擬——和 release.yml 在 Linux 上編 Windows .exe 是一個辦法。
# 2) 執行段：debian-slim，放那一個檔案，外加 git 與 ssh——作者在容器裡用 git 同步書
#    （`docker compose exec novelwarden git -C /data/<書> pull`）。Novelwarden 自己不碰 `.git`：
#    app 裡的版本管理是它自己的存檔點，git 只是作者自己的同步工具。
#    從前是 distroless/cc（沒有 shell 與包管理器，裝不了 git）；換成 slim 之後執行段有一條 RUN，
#    arm64 那份的 apt 要經 QEMU 模擬（docker.yml 裡的 setup-qemu-action），只有這一層。

# 必須是帶 --platform 的命名階段：直接 `COPY --from=oven/bun:1` 拉的是**目標**架構的 bun，
# 在構建機上跑不起來。
FROM --platform=$BUILDPLATFORM oven/bun:1 AS bun

FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /src
# 先只拷依賴清單：只改原始碼時這一層吃快取，不必重灌依賴。
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# 前端產物、內嵌資源與版本號與架構無關，放在 TARGETARCH 之前，兩個架構共用這一層。
RUN node scripts/embed-media.js && mkdir -p /out/data
ARG TARGETARCH
# amd64 用 baseline：預設那版要求 CPU 支援 AVX2，NAS 上常見的賽揚一類沒有，一跑就是 Illegal instruction。
RUN case "$TARGETARCH" in \
      amd64) target=bun-linux-x64-baseline ;; \
      arm64) target=bun-linux-arm64 ;; \
      *) echo "不支援的架構：$TARGETARCH" >&2; exit 1 ;; \
    esac \
 && bun build src/shells/standalone/main.ts --compile --target="$target" --outfile /out/novelwarden

# 以 uid 65532 執行（與從前 distroless:nonroot 同一個號，已經 chown 過的宿主目錄不用重來）。
# 掛宿主目錄時先 `chown -R 65532:65532` 那個目錄。
# ca-certificates：調模型的 HTTPS 與 git 的 https 遠端都要；tzdata：TZ 環境變數要；less：git log 的分頁。
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tzdata git openssh-client less \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 65532 nonroot \
 && useradd --uid 65532 --gid 65532 --home-dir /data --no-create-home --shell /bin/bash nonroot
COPY --from=build /out/novelwarden /usr/local/bin/novelwarden
# 配置與 API Key 在 $HOME/.novelwarden，書也放在這下面：一個卷全裝下。git 的身份（.gitconfig）與 SSH 金鑰（.ssh/）
# 也落在 $HOME，同樣在卷裡。
COPY --from=build --chown=65532:65532 /out/data /data
ENV HOME=/data
USER 65532:65532
WORKDIR /data
VOLUME /data
EXPOSE 3680
ENTRYPOINT ["/usr/local/bin/novelwarden", "--host", "0.0.0.0", "--port", "3680", "--no-open"]
