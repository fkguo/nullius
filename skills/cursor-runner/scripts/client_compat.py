"""Check client interfaces without issuing a model request."""
import os
import re
import shutil
import subprocess
import sys


def identify(client):
    path = shutil.which(client) or client
    try:
        result = subprocess.run([path, "--version"], stdin=subprocess.DEVNULL, capture_output=True,
                                text=True, errors="replace", timeout=3)
        match = re.search(r"\b\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?\b", result.stdout)
        if result.returncode == 0 and match:
            return f"{path} (version {match.group()})"
    except (OSError, subprocess.TimeoutExpired):
        pass
    return f"{path} (version unavailable)"


def check_client(client, command, required):
    path = shutil.which(client)
    if not path:
        print(f"Client executable {client!r} was not found. Check its installation and PATH.", file=sys.stderr)
        return 1
    label = identify(path)
    if os.path.dirname(client) == "":
        alternatives = []
        seen = {os.path.realpath(path)}
        for folder in os.get_exec_path():
            candidate = os.path.abspath(os.path.join(folder, client))
            resolved = os.path.realpath(candidate)
            if resolved not in seen and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                alternatives.append(candidate)
                seen.add(resolved)
        if alternatives:
            print("Other installations later on PATH: " + ", ".join(alternatives), file=sys.stderr)
    try:
        help_result = subprocess.run([path, *command.split(), "--help"], stdin=subprocess.DEVNULL,
                                     capture_output=True, text=True, errors="replace", timeout=12)
    except (OSError, subprocess.TimeoutExpired) as exc:
        print(f"{label}: could not read command help ({exc}).", file=sys.stderr)
        return 1
    if help_result.returncode:
        print(f"{label}: help for {command or 'the client'} exited {help_result.returncode}.", file=sys.stderr)
        return 1
    help_text = re.sub(r"\x1b\[[0-9;]*m", "", help_result.stdout + "\n" + help_result.stderr)
    advertised = set()
    for line in help_text.splitlines():
        if line.lstrip().startswith("-"):
            advertised.update(re.findall(r"(?<![\w-])--?[a-zA-Z][\w-]*", line.lstrip().split("  ", 1)[0]))
    missing = sorted(set(required) - advertised)
    if missing:
        print(f"{label}: the command help does not list {', '.join(missing)}. Check the selected client. "
              "Use a client or a Nullius runner supporting these options.", file=sys.stderr)
        return 1
    print(f"{label}: command help lists {', '.join(required)}.")
    return 0
