#!/bin/bash
# This script is installed outside Runner/participant workspaces by the CLI.
# A nonzero hook exit alone cannot block an always() workflow step.
admitted=0
worker_pid=$PPID
worker_exe=$(/usr/bin/readlink "/proc/$worker_pid/exe") || exit 1
case "$worker_exe" in */bin/Runner.Worker) ;; *) echo 'Nibfin: unsupported Worker parent.' >&2; exit 1 ;; esac
IFS= read -r worker_stat < "/proc/$worker_pid/stat" || exit 1
worker_stat=${worker_stat##*) }
read -ra worker_fields <<< "$worker_stat"
worker_start=${worker_fields[19]}
deny_worker() {
  if [[ $admitted != 1 && $(/usr/bin/readlink "/proc/$worker_pid/exe" 2>/dev/null) == "$worker_exe" ]]; then
    local current_stat
    IFS= read -r current_stat < "/proc/$worker_pid/stat" || return
    current_stat=${current_stat##*) }
    local -a current_fields
    read -ra current_fields <<< "$current_stat"
    if [[ ${current_fields[19]} == "$worker_start" ]]; then kill -KILL "$worker_pid"; fi
  fi
}
trap deny_worker EXIT
trap 'deny_worker; exit 1' HUP INT TERM
hook_directory=$(cd -- "$(/usr/bin/dirname -- "${BASH_SOURCE[0]}")" && pwd -P) || exit 1
# wait is interruptible: a foreground child can defer Bash's signal trap until
# that child exits, leaving cancellation dependent on its network timeout.
/usr/local/bin/node "$hook_directory/runner-job-hook.mjs" "${NIBFIN_RUNNER_JOB_POLICY:-}" &
gate_pid=$!
if wait "$gate_pid"; then
  admitted=1
else
  exit 1
fi
