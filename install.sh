#!/bin/bash
# Pi Desktop — Quick Install Script
# Usage: curl -fsSL https://raw.githubusercontent.com/FaqFirebase/pi-desktop/master/install.sh | bash

set -e

REPO="FaqFirebase/pi-desktop"
RELEASES_PAGE="https://github.com/$REPO/releases"
RELEASES_API="https://api.github.com/repos/$REPO/releases"
BINARY_NAME="pi-desktop"
INSTALL_DIR="${HOME}/.local/bin"
# How many recent releases the asset lookup scans. More than one, so a release
# whose installers are still uploading mid-CI-run does not hide the newest
# release that actually carries them.
RELEASE_SCAN_COUNT=10

# $1: electron-builder platform target (linux|mac|win), i.e. the package:<target>
# npm script to run.
print_build_from_source() {
  echo ""
  echo "Or build from source:"
  echo "  git clone https://github.com/$REPO.git"
  echo "  cd pi-desktop"
  echo "  npm install && npm run package:$1"
}

echo "╔═══════════════════════════════════════╗"
echo "║       Pi Desktop — Installer          ║"
echo "╚═══════════════════════════════════════╝"
echo ""

# Detect platform
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux*)
    PLATFORM="linux"
    # CI packages Linux on an x64 runner only, so x86_64 is the sole
    # architecture with a published AppImage. Bail out here, before Pi is
    # installed as a side effect below, rather than after.
    if [ "$ARCH" != "x86_64" ]; then
      echo "Error: No Pi Desktop build is published for $PLATFORM-$ARCH."
      echo "Prebuilt Linux installers are x86_64 only."
      print_build_from_source "$PLATFORM"
      exit 1
    fi
    # electron-builder names Linux AppImage artifacts with "x86_64", not "x64"
    ARCH_NAME="x86_64"
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
    echo "Please download manually from: $RELEASES_PAGE"
    exit 1
    ;;
esac

echo "Platform: $PLATFORM-$ARCH_NAME"

# Check for Pi dependency
if ! command -v pi &> /dev/null; then
  echo ""
  echo "⚠  Pi is not installed."
  echo "   Installing Pi first..."
  echo ""
  curl -fsSL https://pi.dev/install.sh | sh
  echo ""
fi

echo "✓ Pi found: $(which pi)"

# Download the latest release artifact for this platform.
# Pi Desktop is distributed as a packaged binary, not via npm — see MEMORY.md.
if [ "$PLATFORM" = "linux" ]; then
  echo ""
  echo "Downloading AppImage..."

  # Release assets are versioned (Pi-Desktop-<version>-<os>-<arch>.<ext>), so the
  # URL must be resolved from the release's asset list. /releases/latest excludes
  # pre-releases, so fall back to the newest releases when only pre-releases
  # exist. The list endpoint returns them newest-first and the pipeline below
  # takes the first matching asset in document order, so a release that has not
  # finished uploading its installers is skipped rather than fatal.
  RELEASE_JSON="$(curl -fsSL "$RELEASES_API/latest" 2>/dev/null \
    || curl -fsSL "${RELEASES_API}?per_page=${RELEASE_SCAN_COUNT}" 2>/dev/null \
    || true)"

  if [ -z "$RELEASE_JSON" ]; then
    echo "Error: Could not fetch release information from the GitHub API."
    echo "Please download manually from: $RELEASES_PAGE"
    exit 1
  fi

  DOWNLOAD_URL="$(printf '%s\n' "$RELEASE_JSON" \
    | grep -o '"browser_download_url": *"[^"]*"' \
    | grep -- "-${PLATFORM}-${ARCH_NAME}\.AppImage\"\$" \
    | head -n 1 \
    | sed 's/.*"\(https[^"]*\)".*/\1/')"

  if [ -z "$DOWNLOAD_URL" ]; then
    echo "Error: No ${PLATFORM}-${ARCH_NAME} AppImage found in the recent releases."
    echo "Please download manually from: $RELEASES_PAGE"
    exit 1
  fi

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
  echo "✓ Pi Desktop installed to $OUTPUT"
  echo ""
  echo "Run: $OUTPUT"
  echo ""
else
  echo ""
  echo "Automated install is currently Linux-only."
  echo "Download the installer for $PLATFORM from: $RELEASES_PAGE"
  print_build_from_source "$PLATFORM"
  exit 1
fi
