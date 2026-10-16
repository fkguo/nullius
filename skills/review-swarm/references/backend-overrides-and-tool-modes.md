# Review swarm: backend overrides and reviewer tool modes

## Backend overrides

`run_multi_task.py` supports per-backend overrides:
- `--backend-prompt backend=/path/to/prompt`
- `--backend-prompt @/path/to/overrides.json` (batch mode)
- `--backend-system backend=/path/to/system` or `backend=none`
- `--backend-output backend=relative_or_absolute_path`
- `--backend-tool-mode backend=mode`
- `--timeout-secs N`
- `--max-attempts N`

Notes:
- These flags are repeatable.
- `--backend-prompt @json` supports:
  - shorthand prompt map: `{"gemini": "/path/to/gemini_prompt.txt"}`
  - batch object: `{"prompt": {...}, "system": {...}, "output": {...}}`
- Relative `--backend-output` paths are resolved under `--out-dir`.
- `claude=none` for `--backend-system` is rejected (Claude runner requires a system prompt file).
- For a single run, `--backend-output` does not allow one path for repeated same-backend agents (to avoid output clobbering).
- An explicit hard cap is sized from what the seat actually needs, not from habit: read the
  `elapsed_secs` of the same family on comparable earlier seats (recorded in `meta.json`) and set the
  cap well above it. A cap below a family's ordinary completion time turns every round into an
  `unavailable` seat — an availability failure manufactured by the caller, which the round then has to
  re-dispatch. When no comparable record exists, prefer the default (no hard budget, soft
  `--expected-secs`) over a guessed cap.
- `--timeout-secs` retains its explicit hard-cap meaning: one total deadline per review seat,
  starting at its first runner invocation and shared by both phases, retries and fallback. Default:
  no hard budget (`0`). Advancing output never resets an explicit deadline.
- `--expected-secs` is a soft estimate (default `1200`); exceeding it is recorded and does not kill
  generation. `--claude-live-capture` opts into durable Claude stream events, stderr, partial text and a
  separate terminal result. It is disabled at the runner seam unless requested. Without capture,
  buffered output bytes retain their prior meaning and progress is unknown.
- `--inactivity-secs` is disabled by default. With Claude live capture, it records an inactivity
  diagnostic using event types, advancing counters, timestamps, capture health and process/provider
  status. `--inactivity-grace-secs` (default `30`, positive) requires a further grace check. Only an
  observable stream with earlier advancing content can terminate for confirmed configured inactivity;
  silence before the first advancing event, or unknown/degraded capture, cannot. Repeated heartbeats and
  identical events do not advance the counters. Private reasoning text stays out of progress metadata.
  Activity describes generation, not semantic quality, correctness or billed usage.
- User cancellation, terminal failure, explicit hard-budget exhaustion and confirmed configured
  inactivity preserve durable evidence before process-group cleanup. Partial text cannot substitute for
  a terminal CLI result or a valid review contract.
- `--max-attempts` caps total runner subprocess invocations per seat, including both phases, empty-output retries, and outer fallback. Default: `3`; a complete two-phase review needs at least `2`. Exhausted seats are unavailable, never successful reviews. `meta.json` records the cap and consumed calls in each seat's `seat_budget`.
- The launcher requests one inner attempt from Claude, Codex, Kimi, and OpenCode, and disables supported inner model fallback so the explicit outer fallback policy owns replacement. Gemini has no inner attempt flag: its approved transport routing is preserved, and the seat cap counts runner invocations rather than underlying HTTP requests.
- `--backend-tool-mode` is explicit and backend-specific:
  - `claude=none|review`
  - `gemini=none|review`
  - `opencode=none|workspace`

## Reviewer Tool Modes

Default behavior is explicit:
- Claude, Gemini, and OpenCode now receive an explicit tool mode from `review-swarm`.
- The default mode is `none` for all three backends.
- Tool access must be opted into per backend with `--backend-tool-mode`.

Reviewer-safe modes:
- `claude=review`: maps to a read-only built-in tool profile (`Read,Glob,Grep`).
- `gemini=review`: maps to Gemini CLI `--approval-mode plan` plus local CLI execution (`--no-proxy-first`), sandboxing, and `--extensions none`, which is Gemini's read-only review path.
- When Gemini is in `review` mode and `--gemini-cli-home` was not explicitly set, `review-swarm` now synthesizes an isolated `GEMINI_CLI_HOME` under the run output directory and writes a minimal user settings file there (`mcpServers={}`, `mcp.allowed=[]`) to avoid inheriting reviewer-external user MCP state by default.
- Gemini `review` is a headless review path, not the same interaction mode as the Gemini TUI `/mcp` session. If this path emits MCP discovery noise or does not yield a usable source-grounded verdict on a large packet, prefer a same-model rerun with an embedded-source packet and `gemini=none` rather than assuming TUI MCP health guarantees headless review stability.

OpenCode caveat:
- `opencode=workspace` explicitly grants workspace visibility by passing `--workspace-dir`.
- For formal workspace reviews, prefer OpenCode's official headless-server flow (`opencode serve` + `opencode run --attach ...`) rather than relying only on repeated direct `run --dir ...` cold starts.
- Current `opencode run` CLI does not expose a built-in read-only tool allowlist comparable to Claude/Gemini, so `workspace` is explicit workspace access, not a hard no-mutation guarantee.
- For `opencode=workspace`, prefer workspace-relative file paths in prompts/packets. Large prompts that enumerate absolute workspace paths or globs can push the model into `external_directory` permission requests even when the repo itself is mounted as the workspace.
- Treat `OpenCode workspace` and `OpenCode embedded-source` as two different review roles:
  - `workspace`: packet-challenge / discovery reviewer. Best when blast radius or hidden front-door / consumer drift is still uncertain.
  - `none` + embedded-source packet: verdict-normalization / formal gate reviewer. Best when scope is already narrowed and you need a stable closeout artifact.
- Do not treat an OpenCode workspace pass as "failed" just because the output includes exploratory text or lacks a clean final JSON block. If it still contains source-grounded, current-worktree findings, keep that review signal and only rerun same-model to normalize the gate artifact.
- For formal reviewer use, prefer Claude/Gemini for source-grounded read-only review guarantees; treat OpenCode workspace mode as discovery-strong but gate-fragile, and reserve embedded-source OpenCode passes for final formal-verdict stabilization once packet scope is adequate.
- When packet scope touches public/package/CLI/workflow/default-entry surfaces, also follow the `Front-door Surface Audit` requirement in `AGENTS.md`; runner setup does not replace packet widening.
