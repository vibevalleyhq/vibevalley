#!/bin/sh
# The code is formatted at 160 columns; lib/gen is written by tool/shapegen in its own shape.
set -eu
cd "$(dirname "$0")/.."
find lib test integration_test tool -name '*.dart' ! -path 'lib/gen/*' -print0 | xargs -0 dart format -l 160 --output=none --set-exit-if-changed
