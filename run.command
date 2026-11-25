#!/bin/bash
# Double-click on macOS (or run in a terminal). Pass flags through, e.g. ./run.command --setup
cd "$(dirname "$0")"
python3 run.py "$@"
status=$?
echo; read -n 1 -s -r -p "Press any key to close..."
exit $status
