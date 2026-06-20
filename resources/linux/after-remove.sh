#!/bin/bash
# Post-removal script for Linux packages (deb, rpm)
# Cleans up desktop integration

set -e

# Update desktop database
if command -v update-desktop-database &> /dev/null; then
    update-desktop-database /usr/share/applications 2>/dev/null || true
fi

# Update icon cache
if command -v gtk-update-icon-cache &> /dev/null; then
    gtk-update-icon-cache -f /usr/share/icons/hicolor 2>/dev/null || true
fi

echo "Pi Desktop removed."
echo "Session data in ~/.pi-desktop-gui/ was preserved."
