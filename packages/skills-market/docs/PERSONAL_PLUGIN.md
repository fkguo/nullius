# Portable personal plugin

The personal plugin combines all catalog-listed Nullius skills with three
execution surfaces: `project-mcp`, `hep-mcp`, and `idea-mcp`. Codex and Claude Code
manifests share the same skill payload and MCP configuration. The composed HEP
server already includes its atomic providers, so those are not registered again.

The plugin directory can be copied to another directory or machine unchanged.
Each destination still needs the Nullius CLI and its built runtime. Python,
Node, pnpm, external model CLIs, scientific programs, credentials, and provider
databases remain dependencies of the relevant skills. Packaging the existing
local MCP servers adds no operating-system sandbox.

Build the skill payload and manifests from a source checkout:

```bash
python3 packages/skills-market/scripts/build_personal_plugin.py \
  --source-root /absolute/path/to/nullius-checkout \
  --output /absolute/path/to/plugins/nullius
```

Both paths are required and absolute. The output directory must be named
`nullius` and be outside the source checkout. An existing output requires
`--force`, and replacement is refused unless it already contains a plugin
manifest. The builder stages the output before replacement. Packaging does not
require built JavaScript packages; running the installed CLI does.

Every `.mcp.json` entry uses the command `nullius` with arguments
`runtime mcp <server-name>`. There is no plugin-local launcher, embedded `env`,
absolute executable path, or source checkout binding. Make `nullius` available
on the MCP host's PATH. GUI hosts must receive PATH and any configuration
variables explicitly; setting them only in a terminal does not configure a GUI
host.

Keep machine settings outside the plugin. `nullius runtime mcp` reads
`NULLIUS_RUNTIME_CONFIG` when it names an absolute configuration file; otherwise
it uses `${XDG_CONFIG_HOME:-$HOME/.config}/nullius/runtime.json`. Configure each
server under `servers.<server-name>.env`, for example:

```json
{
  "servers": {
    "project-mcp": {
      "env": {"NULLIUS_PROJECT_ROOT": "/absolute/path/to/research-project"}
    },
    "hep-mcp": {
      "env": {
        "NULLIUS_PROJECT_ROOT": "/absolute/path/to/research-project",
        "HEP_DATA_DIR": "/absolute/path/to/provider-data"
      }
    },
    "idea-mcp": {
      "env": {
        "NULLIUS_PROJECT_ROOT": "/absolute/path/to/research-project",
        "IDEA_MCP_DATA_DIR": "/absolute/path/to/idea-data"
      }
    }
  }
}
```

Project and idea servers require an external project root; idea also requires an
external data directory. A bound project becomes the server's working directory.
HEP may also run as its existing standalone provider without a project binding.
Explicit host environment variables are supported; values in the private
configuration take precedence. The builder does not read or copy this private
configuration, initialize projects, or configure provider credentials.

The output contains:

- `.codex-plugin/plugin.json` and `.claude-plugin/plugin.json`;
- `.mcp.json` containing only portable CLI commands and arguments;
- `skills/` with the catalog's permitted scripts, references, and templates;
- `SOURCE_MANIFEST.json` with source commit, dirty boolean, relative source paths,
  and SHA-256 hashes for every copied payload file;
- per-skill `.market_install.json` containing public source provenance, without
  the source checkout's local path.

Both the plugin builder and ordinary copy installer inspect the actual selected
payload, including ignored or untracked files. They reject sensitive credential
filenames, high-confidence secret patterns, concrete machine home paths, and
selected symlinks before copying. Diagnostics name the relative file and issue
category without printing matched values. This bounded static check does not
replace reviewing arbitrary private research content; public attribution and
repository references are preserved.

Skill text is copied without runtime-note injection. Development smoke fixtures
are excluded by the catalog. Script helpers prefer bundled sibling runners.
Helpers that need source packages resolve an explicit `NULLIUS_WORKSPACE_ROOT`
first, then a containing Nullius source checkout, then `nullius runtime path` from
the current PATH. A pnpm workspace marker alone is insufficient: the canonical
package identities and required source entrypoints must also be present. Ordinary copy-installed skills use the same discovery; install
metadata does not select a runtime. Skill-local Python virtual environments and
other installed dependencies must be recreated on the destination as needed.

Skills are snapshots: rebuild and reload after changing source skills. A dirty
source tree is recorded as dirty, never presented as an immutable commit pin.
The manifest intentionally omits absolute source/Node paths and the working
tree's changed-file list. Public attribution and repository references in skill
payloads remain intact.

Building does not install into a host or edit a personal marketplace. It does
not create a ChatGPT app, tunnel, remote endpoint, or `.app.json`. Host connection
configuration and capability checks remain separate. Shared skill contracts do
not supply native subagents, credentials, or scheduling that a host lacks.

Focused validation:

```bash
python3 -m pytest -q packages/skills-market/tests/test_personal_plugin.py \
  packages/skills-market/tests/test_install_skill.py
python3 packages/skills-market/scripts/validate_market.py
```

After building the actual workspace packages, the opt-in migration smoke copies
an already-built plugin and ordinary installed skills to a second directory,
then uses another CLI checkout:

```bash
NULLIUS_REAL_PLUGIN_SMOKE=1 python3 -m pytest -q -s \
  packages/skills-market/tests/test_personal_plugin_live.py
```

It sends `initialize` and `tools/list` to the real servers, checks tool-name
uniqueness and project working directories, exercises copied harness help, and
renders a minimal project through the copied team scaffold. All project and
provider paths are temporary fixtures; no provider tool or external model is
called. It reports a `composition-report.json` path and requires `/proc` or
`lsof` to observe process working directories.
