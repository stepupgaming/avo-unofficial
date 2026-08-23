#!/bin/sh
set -e
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
IN=${1:-"$ROOT/operator/inbox"}
if [ $# -gt 0 ]; then shift; fi
OUT=${AVO_GENOME:-"$ROOT/operator/out"}
exec node "$ROOT/packages/dsh-avo/lib/ingest-cli.js" "$IN" --out "$OUT" "$@"
