# mc-desktop 构建与打包。
#
# macOS 打包(在 Mac 上执行):
#   make macos          # universal .app/.dmg,内核 sidecar 打进包
# 前置:Go 1.25+、Node 22、Rust 且已加双架构 target:
#   rustup target add aarch64-apple-darwin x86_64-apple-darwin

AGENT_DIR   := ../agent
BIN_DIR     := binaries
SIDECAR_ARM := $(BIN_DIR)/mc-agent-aarch64-apple-darwin
SIDECAR_X64 := $(BIN_DIR)/mc-agent-x86_64-apple-darwin
SIDECAR_UNI := $(BIN_DIR)/mc-agent-universal-apple-darwin
TAURI       := npx --yes @tauri-apps/cli@^2
GOFLAGS     := -trimpath -ldflags "-s -w"

.PHONY: dev run macos check-macos kernel-universal icons clean

# ---------- 开发 ----------

dev:
	cargo build

run: dev
	./target/debug/mc-desktop

# ---------- macOS 打包(universal .app/.dmg,内核 sidecar)----------

macos: check-macos kernel-universal icons
	$(TAURI) build --target universal-apple-darwin --config tauri.macos.conf.json
	@echo ""
	@echo "打包完成,分发产物:"
	@ls -lh target/universal-apple-darwin/release/bundle/dmg/*.dmg 2>/dev/null || true
	@echo "(.app 在 target/universal-apple-darwin/release/bundle/macos/)"
	@echo "提示: 包未签名,同事首次打开需 右键→打开;提示已损坏时执行"
	@echo "      xattr -cr /Applications/MonkeyCode.app"

check-macos:
	@[ "$$(uname -s)" = "Darwin" ] || { echo "错误: macOS 打包需在 Mac 上执行"; exit 1; }
	@rustup target list --installed | grep -q aarch64-apple-darwin || \
		{ echo "错误: 缺少 rust target,先执行: rustup target add aarch64-apple-darwin x86_64-apple-darwin"; exit 1; }
	@rustup target list --installed | grep -q x86_64-apple-darwin || \
		{ echo "错误: 缺少 rust target,先执行: rustup target add x86_64-apple-darwin"; exit 1; }

# 双架构编译内核 sidecar。universal 打包会按架构各编译一遍,每遍的
# tauri_build 都要求存在 <name>-<本架构 triple> 文件,最终 bundle 阶段
# 再合成/取 universal——三个命名全部备齐,覆盖每个阶段的查找路径。
kernel-universal:
	mkdir -p $(BIN_DIR)
	cd $(AGENT_DIR) && CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build $(GOFLAGS) -o $(abspath $(SIDECAR_ARM)) ./cmd/mc-agent
	cd $(AGENT_DIR) && CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build $(GOFLAGS) -o $(abspath $(SIDECAR_X64)) ./cmd/mc-agent
	lipo -create -output $(SIDECAR_UNI) $(SIDECAR_ARM) $(SIDECAR_X64)
	$(SIDECAR_UNI) --version

icons:
	$(TAURI) icon icons/icon.png

clean:
	rm -rf $(BIN_DIR) target
