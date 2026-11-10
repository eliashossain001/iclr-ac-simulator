#!/usr/bin/env bash
# Download, validate, build and test. Stops at the first failure.
set -euo pipefail
cd "$(dirname "$0")"
python3 pipeline/fetch.py
python3 pipeline/backtest.py
python3 pipeline/build.py
python3 -m unittest discover -s tests
echo "Done. Preview: python3 -m http.server -d docs 8000"
