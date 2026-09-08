#!/usr/bin/env bash
# Installs the launcher (.desktop + icon + systemd user unit) and --enable
# optionally starts the backend now and on every login. Run from the project
# root; no sudo needed.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS_ROOT="${DSH_HARNESS_ROOT:-/home/xiaoxin/deepseek-harness}"
NODE_BIN="${DSH_NODE_BIN:-/home/xiaoxin/.hermes/node/bin/node}"

APPS_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor"
SYSTEMD_DIR="$HOME/.config/systemd/user"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
LOG_DIR="$DSH_HOME/desktop"

UNINSTALL=0
ENABLE=0
for arg in "$@"; do
  case "$arg" in
    --uninstall) UNINSTALL=1 ;;
    --enable)    ENABLE=1 ;;
    *)           echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if [ "$UNINSTALL" = "1" ]; then
  systemctl --user disable --now dsh-desktop-x.service 2>/dev/null || true
  rm -f "$SYSTEMD_DIR/dsh-desktop-x.service"
  rm -f "$APPS_DIR/dsh-desktop-x.desktop"
  for s in 512 256 128 64 48; do rm -f "$ICON_DIR/${s}x${s}/apps/dsh-desktop-x.png"; done
  # Legacy names from before the dsh-desktop-x rename (dsh-web.service /
  # dsh-desktop.desktop / dsh-desktop.png). The unit may still be the one
  # running the live backend, so stop it only here, where uninstall is meant
  # to take the backend down.
  systemctl --user disable --now dsh-web.service 2>/dev/null || true
  rm -f "$SYSTEMD_DIR/dsh-web.service"
  rm -f "$APPS_DIR/dsh-desktop.desktop"
  for s in 512 256 128 64 48; do rm -f "$ICON_DIR/${s}x${s}/apps/dsh-desktop.png"; done
  echo "已卸载 dsh-desktop-x"
  exit 0
fi

# Migrate a pre-rename install: stop the legacy unit from coming back at the
# next login, but never touch the running process — that may well be the
# backend serving the live GUI right now.
if [ -f "$SYSTEMD_DIR/dsh-web.service" ]; then
  systemctl --user disable dsh-web.service 2>/dev/null || true
  echo "→ 已停用旧单元 dsh-web.service（运行中的实例不受影响，重启后由 dsh-desktop-x.service 接管）"
fi

if [ ! -x "$NODE_BIN" ]; then echo "找不到 node：$NODE_BIN" >&2; exit 1; fi
if [ ! -f "$HARNESS_ROOT/apps/cli/lib/bin.js" ]; then echo "找不到 dsh bin：$HARNESS_ROOT/apps/cli/lib/bin.js" >&2; exit 1; fi

echo "→ 编译 dsh-desktop-x"
(cd "$ROOT" && npm run build)

echo "→ 写入 .desktop 启动器"
mkdir -p "$APPS_DIR"
cat > "$APPS_DIR/dsh-desktop-x.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=DeepSeek Harness
Comment=dsh web 桌面客户端（带托盘与后端管理）
Exec=$ROOT/node_modules/electron/dist/electron $ROOT
Icon=dsh-desktop-x
Terminal=false
Categories=Development;Utility;
StartupNotify=true
StartupWMClass=DeepSeek Harness
EOF
chmod 0644 "$APPS_DIR/dsh-desktop-x.desktop"

echo "→ 写入图标（hicolor 256/512；托盘直接用 build/tray-*）"
for pair in "512:app-icon.png" "256:app-icon-256.png"; do
  size="${pair%%:*}"
  src="${pair#*:}"
  dest="$ICON_DIR/${size}x${size}/apps/dsh-desktop-x.png"
  mkdir -p "$(dirname "$dest")"
  cp "$ROOT/build/$src" "$dest"
done
for size in 128 64 48; do
  dest="$ICON_DIR/${size}x${size}/apps/dsh-desktop-x.png"
  mkdir -p "$(dirname "$dest")"
  ( cd "$ROOT" && node --input-type=module -e "import sharp from 'sharp'; await sharp('build/app-icon-256.png').resize($size, $size).png().toFile('$dest')" )
done

echo "→ 写入 systemd user unit"
mkdir -p "$SYSTEMD_DIR" "$LOG_DIR"
cat > "$SYSTEMD_DIR/dsh-desktop-x.service" <<EOF
[Unit]
Description=DeepSeek Harness Web backend
After=default.target

[Service]
Type=simple
# Session history is grouped by the backend's working directory
# (~/.dsh/sessions/--home-xiaoxin--/...), so it must match where the user's
# own \`dsh web\` runs from — the checkout would show an empty history.
WorkingDirectory=$HOME
ExecStart=$NODE_BIN $HARNESS_ROOT/apps/cli/lib/bin.js web --no-open
Environment=DSH_HOME=$DSH_HOME
Restart=on-failure
RestartSec=5
ExecStartPre=/usr/bin/mkdir -p $LOG_DIR
StandardOutput=append:$LOG_DIR/backend.log
StandardError=append:$LOG_DIR/backend.log

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload

if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t "$ICON_DIR" 2>/dev/null || true
fi
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APPS_DIR" 2>/dev/null || true
fi

echo
echo "✓ 已安装："
echo "  $APPS_DIR/dsh-desktop-x.desktop"
echo "  $SYSTEMD_DIR/dsh-desktop-x.service"
echo "  $ICON_DIR/{256,512}x{256,512}/apps/dsh-desktop-x.png"
if [ "$ENABLE" = "1" ]; then
  echo
  echo "→ 启动并启用后端：dsh-desktop-x.service"
  systemctl --user enable --now dsh-desktop-x.service
  systemctl --user --no-pager --full status dsh-desktop-x.service | sed -n '1,8p' || true
else
  echo
  echo "  启动后端："
  echo "    systemctl --user enable --now dsh-desktop-x.service"
  echo "  停用后端："
  echo "    systemctl --user disable --now dsh-desktop-x.service"
  echo "  卸载全部："
  echo "    bash $ROOT/scripts/install-system.sh --uninstall"
fi
