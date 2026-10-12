#!/bin/bash
ROOT=$(cd "$(dirname "$0")/../.." && pwd); SP=/tmp/winchat-e2e; mkdir -p $SP
cd $ROOT/worker
nohup npx wrangler dev --port 8787 --ip 127.0.0.1 > $SP/wrangler.log 2>&1 &
sleep 14
curl -s http://127.0.0.1:8787/health
echo
grep -c "SWEEP_MS" $SP/wrangler.log
