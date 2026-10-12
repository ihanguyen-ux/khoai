#!/bin/bash
# usage: launch.sh  -> starts Xvfb, openbox and two Electron instances (9222, 9223)
export DISPLAY=:99
pgrep -x Xvfb >/dev/null || (nohup Xvfb :99 -screen 0 1400x900x24 >/dev/null 2>&1 &)
sleep 1
pgrep -x openbox >/dev/null || (nohup openbox >/dev/null 2>&1 &)
sleep 1
cd $(cd "$(dirname "$0")/../.." && pwd)
SP=/tmp/winchat-e2e; mkdir -p $SP/shots
for n in 1 2; do
  port=$((9221+n))
  rm -rf $SP/ud$n
  (nohup ./node_modules/electron/dist/electron . --no-sandbox --disable-gpu --disable-dev-shm-usage \
    --use-fake-device-for-media-stream --use-fake-ui-for-media-stream \
    --remote-debugging-port=$port --user-data-dir=$SP/ud$n > $SP/electron$n.log 2>&1 &)
done
sleep 6
curl -s http://127.0.0.1:9222/json/version | head -3
curl -s http://127.0.0.1:9223/json/version | head -3
