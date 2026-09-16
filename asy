#!/usr/bin/env sh
# AnyShare 高校网盘 CLI —— POSIX 启动器 (Linux / macOS / WSL)
# 用法: ./asy login | ./asy ls | ./asy put <本地文件> <远程路径> ...
set -e
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未找到 Node.js，请先安装：https://nodejs.org/ (需要 18+)" >&2
  exit 1
fi

exec node "$DIR/asy.js" "$@"