#!/bin/bash
# PI Desktop — Quick Install Script
# Usage: curl -fsSL https://raw.githubusercontent.com/FaqFirebase/pi-desktop/master/install.sh | bash

set -e

REPO="FaqFirebase/pi-desktop"
BINARY_NAME="pi-desktop"
INSTALL_DIR="${HOME}/.local/bin"

echo "╔═══════════════════════════════════════╗"
echo "║       PI Desktop — Installer          ║"
echo "╚═══════════════════════════════════════╝"
echo ""

# Detect platform
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux*)
    PLATFORM="linux"
    if [ "$ARCH" = "x86_64" ]; then
      ARCH_NAME="x64"
    elif [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
      ARCH_NAME="arm64"
    else
      echo "Error: Unsupported architecture: $ARCH"
      exit 1
    fi
    ;;
  Darwin*)
    PLATFORM="mac"
    if [ "$ARCH" = "x86_64" ]; then
      ARCH_NAME="x64"
    elif [ "$ARCH" = "arm64" ]; then
      ARCH_NAME="arm64"
    fi
    ;;
  MINGW*|MSYS*|CYGWIN*)
    PLATFORM="win"
    ARCH_NAME="x64"
    ;;
  *)
    echo "Error: Unsupported OS: $OS"
    echo "Please download manually from: https://github.com/$REPO/releases"
    exit 1
    ;;
esac

echo "Platform: $PLATFORM-$ARCH_NAME"

# Check for PI dependency
if ! command -v pi &> /dev/null; then
  echo ""
  echo "⚠  PI is not installed."
  echo "   Installing PI first..."
  echo ""
  curl -fsSL https://pi.dev/install.sh | sh
  echo ""
fi

echo "✓ PI found: $(which pi)"

# Download the latest release artifact for this platform.
# PI Desktop is distributed as a packaged binary, not via npm — see MEMORY.md.
if [ "$PLATFORM" = "linux" ]; then
  echo ""
  echo "Downloading AppImage..."

  DOWNLOAD_URL="https://github.com/$REPO/releases/latest/download/PI-Desktop-${PLATFORM}-${ARCH_NAME}.AppImage"

  mkdir -p "$INSTALL_DIR"
  OUTPUT="$INSTALL_DIR/$BINARY_NAME"

  echo "Downloading: $DOWNLOAD_URL"
  curl -fsSL "$DOWNLOAD_URL" -o "$OUTPUT"
  chmod +x "$OUTPUT"

  if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
    echo ""
    echo "Add to your PATH:"
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    echo ""
    echo "Add to ~/.bashrc or ~/.zshrc to make permanent."
  fi

  echo ""
  echo "✓ PI Desktop installed to $OUTPUT"
  echo ""
  echo "Run: $OUTPUT"
  echo ""
else
  echo ""
  echo "Automated install is currently Linux-only."
  echo "Download the installer for $PLATFORM from: https://github.com/$REPO/releases"
  echo ""
  echo "Or build from source:"
  echo "  git clone https://github.com/$REPO.git"
  echo "  cd pi-desktop"
  echo "  npm install && npm run package:$PLATFORM"
  exit 1
fi
