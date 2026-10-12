#!/bin/bash
# usage: swap-worker.sh fast|real
ROOT=$(cd "$(dirname "$0")/../.." && pwd); SP=/tmp/winchat-e2e; mkdir -p $SP
cd $ROOT/worker
for pid in $(ps aux | awk '/workerd|wrangler-dist|wrangler dev/ && !/swap-worker/ && !/awk/ {print $2}'); do kill $pid 2>/dev/null; done
sleep 2
if [ "$1" = fast ]; then cp .dev.vars.fast .dev.vars; else grep -v -E "^(SWEEP_MS|IDLE_MS|JOIN_TIMEOUT_MS)" .dev.vars.fast > .dev.vars; fi
nohup npx wrangler dev --port 8787 --ip 127.0.0.1 > $SP/wrangler.log 2>&1 &
sleep 14
curl -s http://127.0.0.1:8787/health; echo
