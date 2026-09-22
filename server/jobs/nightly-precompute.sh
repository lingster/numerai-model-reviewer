#!/bin/sh
# Precompute every tournament into the SQLite file, one after another. A failed
# tournament does not stop the others, but the run still exits non-zero.
#
# Defaults lift the caps that exist only for D1's free plan; override with the
# PRECOMPUTE_* variables in docker-compose.yml.
set -u
cd /app/server

status=0
for tournament in ${PRECOMPUTE_TOURNAMENTS:-8 11 12}; do
	echo "=== tournament ${tournament} ==="
	node_modules/.bin/tsx src/precompute-sqlite.ts \
		--tournament "${tournament}" \
		--no-cache \
		--top-n "${PRECOMPUTE_TOP_N:-1000000}" \
		--backfill-rounds "${PRECOMPUTE_BACKFILL_ROUNDS:-5000}" \
		--refresh-overlap "${PRECOMPUTE_REFRESH_OVERLAP:-70}" \
		|| { echo "tournament ${tournament} failed"; status=1; }
done
exit "${status}"
