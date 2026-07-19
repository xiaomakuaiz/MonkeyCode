#!/usr/bin/env bash
# 假 wsl.exe:在无 Windows 的开发机上冒烟壳的 WSL 代码路径。
# 用法:MC_WSL_EXE=$(pwd)/scripts/fake-wsl.sh MC_AGENT_LINUX_BIN=<本机 mc-agent> \
#       且 config.json 写 "kernel_env": "wsl:Ubuntu-22.04",启动 mc-desktop。
# 仅覆盖壳实际使用的三种调用形态;开发工具,不随包分发。
set -u

# wsl -l -q:发行版列表(FAKE_WSL_UTF16=1 时输出 BOM + UTF-16LE + CRLF,
# 模拟老版 wsl.exe,验证壳的双解码)
if [ "${1:-}" = "-l" ]; then
  if [ -n "${FAKE_WSL_UTF16:-}" ]; then
    printf '\xff\xfe'
    printf 'Ubuntu-22.04\r\ndocker-desktop\r\n' | iconv -f UTF-8 -t UTF-16LE
  else
    printf 'Ubuntu-22.04\ndocker-desktop\n'
  fi
  exit 0
fi

if [ "${1:-}" = "-d" ]; then shift 2; fi
[ "${1:-}" = "--exec" ] || { echo "fake-wsl: 仅支持 --exec 形态,得到: $*" >&2; exit 1; }
shift

case "${1:-}" in
  /bin/sh)
    # prepare 调用(/bin/sh -c '<wslpath 批量翻译>' sh <p1> <p2> ...):
    # 本机路径翻译即恒等,回显路径参数即可
    shift 4
    for p in "$@"; do printf '%s\n' "$p"; done
    ;;
  pkill)
    exec "$@"
    ;;
  *)
    # serve 调用:直接执行本机二进制,stdin/stdout 透传(--watch-stdin 契约保持)
    exec "$@"
    ;;
esac
