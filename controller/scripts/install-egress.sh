#!/bin/sh
set -eu
# Run as the trusted host operator, outside all participant workspaces.
# Arguments: pinned Agent image digest, installed read-only proxy module path.
image=$1
proxy_source=$2
test -f "$proxy_source"
docker network inspect nibfin-agent-private >/dev/null 2>&1 || docker network create --internal --subnet 172.30.91.0/24 --opt com.docker.network.bridge.gateway_mode_ipv4=isolated nibfin-agent-private
docker network inspect nibfin-proxy-egress >/dev/null 2>&1 || docker network create nibfin-proxy-egress
source_hash=$(sha256sum "$proxy_source" | cut -d " " -f 1)
docker run -d --label "io.nibfin.egress-source-sha256=$source_hash" --name nibfin-egress-proxy --restart unless-stopped --read-only --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 --pids-limit 64 --memory 128m --network name=nibfin-agent-private,ip=172.30.91.2 --network nibfin-proxy-egress --mount "type=bind,src=$proxy_source,dst=/proxy.mjs,readonly" --entrypoint node "$image" /proxy.mjs
