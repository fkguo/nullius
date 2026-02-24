#!/usr/bin/env node

const { spawnSync } = require("child_process");

function whichPython() {
  return process.env.HEP_AUTORESEARCH_PYTHON || "python3";
}

function runPython(args) {
  const python = whichPython();
  const res = spawnSync(python, args, { stdio: "inherit" });
  return res.status === null ? 1 : res.status;
}

function main() {
  const args = process.argv.slice(2);

  // Prefer `python3 -m hep_autoresearch ...` so it works even if the
  // console-script path isn't on $PATH (common with user installs).
  const exitCode = runPython(["-m", "hep_autoresearch", ...args]);
  if (exitCode === 0) return 0;

  // If module import failed, print a clearer hint.
  // (We intentionally don't try to parse stderr; keep it simple and robust.)
  if (exitCode === 1 || exitCode === 2) {
    console.error("");
    console.error("[hep-autoresearch] Python package not available.");
    console.error("Install the Python CLI first, e.g.:");
    console.error("  python3 -m pip install -e .");
    console.error("  # or (recommended) pipx install -e .");
    console.error("");
    console.error("You can also set HEP_AUTORESEARCH_PYTHON to choose a Python interpreter.");
  }
  return exitCode;
}

process.exit(main());

