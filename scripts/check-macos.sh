#!/bin/bash
set -euo pipefail
if [[ "$(uname -s)" != Darwin ]]; then echo 'Run this check on a Mac.'; exit 1; fi
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
node --test test/workflows.test.js test/extras.test.js
xcrun --find swiftc
stage="$(mktemp -d "${TMPDIR:-/tmp}/computer-pro-check.XXXXXX")"
trap 'rm -f "$stage/extras"; rmdir "$stage"' EXIT
xcrun swiftc -O native/macos/Extras.swift -o "$stage/extras"
printf '%s' '{"method":"capabilities"}' | "$stage/extras"
printf '%s' '{"method":"apps"}' | "$stage/extras"
echo 'Compiler and capability checks passed. Desktop permissions, launch, OCR, DOM and shutdown still require interactive acceptance.'
