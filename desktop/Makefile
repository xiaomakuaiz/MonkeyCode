# desktop 构建与打包。
#
# 引擎 sidecar 源码缺省取仓库根的 agent/ submodule(git submodule update --init agent);
# 要用别处的 ohmyagent 检出时可覆盖:
#   export OHMYAGENT_SRC=/path/to/ohmyagent
#
# macOS 打包(在 Mac 上执行):
#   make macos          # universal .app/.dmg,引擎 sidecar 打进包
# 前置:Go 1.25+、Node 22、Rust 且已加双架构 target:
#   rustup target add aarch64-apple-darwin x86_64-apple-darwin
#
# Windows 打包(在 Windows 上执行,Git Bash/MSYS;无 Windows 机器时走
# CI: .github/workflows/desktop-windows.yml):
#   make windows        # NSIS 安装包,引擎 sidecar 打进包

# 缺省 = agent/ submodule;未初始化时下方守卫会给出可执行的报错
OHMYAGENT_SRC ?= $(abspath $(CURDIR)/../agent)
BIN_DIR     := binaries
SIDECAR_ARM := $(BIN_DIR)/ohmyagent-aarch64-apple-darwin
SIDECAR_X64 := $(BIN_DIR)/ohmyagent-x86_64-apple-darwin
SIDECAR_UNI := $(BIN_DIR)/ohmyagent-universal-apple-darwin
SIDECAR_WIN := $(BIN_DIR)/ohmyagent-x86_64-pc-windows-msvc.exe
TAURI       := npx --yes @tauri-apps/cli@^2
GOFLAGS     := -trimpath -ldflags "-s -w"
GOFLAGS_WIN := -trimpath -ldflags "-s -w -H=windowsgui"

.PHONY: dev run macos macos-release set-release-version windows windows-release check-signing check-macos check-windows check-ohmy-src engine-universal engine-windows browser-extension icons clean

# ---------- 开发 ----------

dev:
	cargo build

run: dev
	./target/debug/monkeycode-desktop

# ---------- macOS 打包(universal .app/.dmg,引擎 sidecar)----------

macos: check-macos engine-universal browser-extension icons/icon.icns
	$(TAURI) build --target universal-apple-darwin --config tauri.macos.conf.json $(EXTRA_TAURI_CONFIG)
	@echo ""
	@echo "打包完成,分发产物:"
	@ls -lh target/universal-apple-darwin/release/bundle/dmg/*.dmg 2>/dev/null || true
	@echo "(.app 在 target/universal-apple-darwin/release/bundle/macos/)"
	@echo "提示: 包未签名,同事首次打开需 右键→打开;提示已损坏时执行"
	@echo "      xattr -cr /Applications/MonkeyCode.app"

# 发布构建:在 macos 基础上叠加 createUpdaterArtifacts(需 TAURI_SIGNING_PRIVATE_KEY
# 签名),并汇集 updater 产物(带版本文件名的 .app.tar.gz + latest.json)到
# bundle/updater/,供人工上传 OSS。
macos-release: EXTRA_TAURI_CONFIG += --config tauri.release.conf.json

macos-release:
	$(MAKE) check-signing
	$(MAKE) set-release-version
	$(MAKE) macos EXTRA_TAURI_CONFIG="$(EXTRA_TAURI_CONFIG)"
	python3 scripts/gen-latest-json.py

# 发布版本只接受当前提交上的 vYYMMDDNN tag；由统一脚本同步 Tauri、Cargo
# manifest 及主/Win7 lockfile。普通 macos 构建不修改版本文件。
set-release-version:
	@tag="$$(git describe --tags --exact-match \
		--match 'v[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]' HEAD 2>/dev/null)"; \
		[ -n "$$tag" ] || { echo "错误: 发布构建要求当前提交带 vYYMMDDNN tag"; exit 1; }; \
		python3 scripts/set_release_version.py "$$tag"

check-signing:
	@[ -n "$$TAURI_SIGNING_PRIVATE_KEY" ] || \
		{ echo "错误: 发布构建需要 TAURI_SIGNING_PRIVATE_KEY(updater 产物签名私钥)"; exit 1; }

check-macos:
	@[ "$$(uname -s)" = "Darwin" ] || { echo "错误: macOS 打包需在 Mac 上执行"; exit 1; }
	@rustup target list --installed | grep -q aarch64-apple-darwin || \
		{ echo "错误: 缺少 rust target,先执行: rustup target add aarch64-apple-darwin x86_64-apple-darwin"; exit 1; }
	@rustup target list --installed | grep -q x86_64-apple-darwin || \
		{ echo "错误: 缺少 rust target,先执行: rustup target add x86_64-apple-darwin"; exit 1; }

check-ohmy-src:
	@[ -n "$(OHMYAGENT_SRC)" ] && [ -d "$(OHMYAGENT_SRC)/cmd/ohmyagent" ] || \
		{ echo "错误: 引擎源码不存在($(OHMYAGENT_SRC))。初始化 submodule:"; \
		  echo "  git submodule update --init agent"; \
		  echo "或指向别处检出: export OHMYAGENT_SRC=/path/to/ohmyagent"; exit 1; }

# 双架构编译引擎 sidecar。universal 打包会按架构各编译一遍,每遍的
# tauri_build 都要求存在 <name>-<本架构 triple> 文件,最终 bundle 阶段
# 再合成/取 universal——三个命名全部备齐,覆盖每个阶段的查找路径。
# externalBin 列在基础配置里:缺二进制打包直接失败(不再有"包里没引擎"的静默)。
engine-universal: check-ohmy-src
	mkdir -p $(BIN_DIR)
	cd $(OHMYAGENT_SRC) && CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build $(GOFLAGS) -o $(abspath $(SIDECAR_ARM)) ./cmd/ohmyagent
	cd $(OHMYAGENT_SRC) && CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build $(GOFLAGS) -o $(abspath $(SIDECAR_X64)) ./cmd/ohmyagent
	lipo -create -output $(SIDECAR_UNI) $(SIDECAR_ARM) $(SIDECAR_X64)

# ---------- Windows 打包(NSIS 安装包,引擎 sidecar)----------

windows: check-windows engine-windows browser-extension
	$(TAURI) build --config tauri.windows.conf.json $(EXTRA_TAURI_CONFIG)
	@echo ""
	@echo "打包完成,分发产物:"
	@ls -lh target/release/bundle/nsis/*.exe 2>/dev/null || true

# 发布构建:在 windows 基础上叠加 createUpdaterArtifacts(需 TAURI_SIGNING_PRIVATE_KEY
# 签名),并汇集 updater 产物(带版本文件名的 setup.exe + latest-windows.json)到
# bundle/updater/,供人工上传 OSS。win7 通道由 CI(desktop-win7.yml)产出。
windows-release: EXTRA_TAURI_CONFIG := --config tauri.release.conf.json
windows-release: check-signing windows
	python3 scripts/gen-latest-json.py windows

check-windows:
	@[ "$$OS" = "Windows_NT" ] || { echo "错误: Windows 打包需在 Windows 上执行(无 Windows 机器时用 CI: desktop-windows.yml)"; exit 1; }

# Windows 引擎 sidecar(x64;tauri bundle 按 <name>-<triple>.exe 查找,
# 安装后落地为应用同目录的 ohmyagent.exe,与壳的 find_ohmyagent 查找顺序吻合)。
# WSL 模式的 ohmyagent-linux 随 M3 落地。
engine-windows: check-ohmy-src
	mkdir -p $(BIN_DIR)
	cd $(OHMYAGENT_SRC) && CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build $(GOFLAGS_WIN) -o $(abspath $(SIDECAR_WIN)) ./cmd/ohmyagent
	python3 scripts/check-pe-subsystem.py $(SIDECAR_WIN) gui

# 浏览器扩展:随包分发(tauri bundle.resources 引用 ../browser-extension/dist,
# 缺失会打包失败)。
browser-extension:
	cd ../browser-extension && npm ci && npm run build

# 图标产物已入库,仅源图(icons/source.png,1024²)更新时重新生成。
# 注意:tauri icon 无平台过滤参数,会连带产出 ios/android(生成后清理);
# 且其输出包含 icon.png 本身——源图必须与输出分离,否则会被覆盖。
icons/icon.icns: icons/source.png
	$(TAURI) icon icons/source.png
	rm -rf icons/android icons/ios

icons: icons/icon.icns

clean:
	rm -rf $(BIN_DIR) target
