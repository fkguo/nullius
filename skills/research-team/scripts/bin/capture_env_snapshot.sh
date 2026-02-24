#!/usr/bin/env bash
set -euo pipefail

out="${1:-env_snapshot.txt}"

{
  echo "# Environment snapshot"
  echo "# created_at: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  echo

  echo "## System"
  uname -a || true
  echo

  if command -v sw_vers >/dev/null 2>&1; then
    echo "### macOS"
    sw_vers || true
    echo
  fi

  if command -v nvidia-smi >/dev/null 2>&1; then
    echo "### NVIDIA"
    nvidia-smi || true
    echo
  fi

  echo "## Julia"
  if command -v julia >/dev/null 2>&1; then
    julia -e 'using InteractiveUtils; versioninfo();' || true
    echo
    julia -e 'import Pkg; Pkg.status();' || true
  else
    echo "(julia not found)"
  fi
  echo

  echo "## Python"
  if command -v python3 >/dev/null 2>&1; then
    python3 -V || true
    python3 -c 'import sys; print("executable:", sys.executable)' || true
  else
    echo "(python3 not found)"
  fi
  echo

  if command -v pip3 >/dev/null 2>&1; then
    echo "### pip3 freeze"
    pip3 freeze || true
    echo
  fi

  if command -v conda >/dev/null 2>&1; then
    echo "### conda info"
    conda info || true
    echo
    echo "### conda list"
    conda list || true
    echo
  fi
} >"${out}"

echo "[ok] wrote: ${out}"

