#!/bin/sh
set -eu
# Reviewed operator installation, not executed by the public caller or Agent.
test "$(id -u)" = 0 || { echo 'Run as the trusted machine administrator.' >&2; exit 1; }
# Match both ExecStart paths; fail before installing or enabling anything.
test -x /usr/local/bin/node || { echo 'Required executable: /usr/local/bin/node (Node.js >=22).' >&2; exit 1; }
/usr/local/bin/node -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("Node.js >=22 is required at /usr/local/bin/node"); process.exit(1); }'
test -f /etc/nibfin/public.json
test -f /opt/nibfin/core/bin/controller.mjs
id nibfin >/dev/null
unit=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/nibfin-dispatch.service
install -m 0644 "$unit" /etc/systemd/system/nibfin-dispatch.service
systemctl daemon-reload
systemctl enable --now nibfin-dispatch.service
systemctl is-active --quiet nibfin-dispatch.service
