#!/bin/bash
# Rebuild and reinstall the plugin into WebStorm
set -e

PLUGIN_DIR="$HOME/Library/Application Support/JetBrains/WebStorm2025.3/plugins/codeagent-mobile"
BUILD_DIR="$(dirname "$0")/build/distributions"
ZIP="$BUILD_DIR/codeagent-mobile-1.0.0.zip"

echo "Building plugin..."
JAVA_HOME=/opt/homebrew/Cellar/openjdk@17/17.0.18/libexec/openjdk.jdk/Contents/Home \
  "$(dirname "$0")/gradlew" buildPlugin -p "$(dirname "$0")" 2>&1 | tail -3

if [ ! -f "$ZIP" ]; then
  echo "ERROR: Build artifact not found at $ZIP"
  exit 1
fi

echo "Removing old plugin..."
rm -rf "$PLUGIN_DIR"

echo "Installing new plugin..."
unzip -q -o "$ZIP" -d "$HOME/Library/Application Support/JetBrains/WebStorm2025.3/plugins/"

echo "Restarting WebStorm..."
osascript -e 'quit app "WebStorm"'
sleep 2
open -a "WebStorm"

echo "Done. WebStorm is restarting with the updated plugin."
