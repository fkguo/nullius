---
name: dsh-cli-runner
description: Dispatch a bounded file-prompt task through the local DeepSeek Harness (dsh) headless CLI to an explicitly selected provider/model. Use for reviews, drafting or analysis from another host; captures raw sessions, rejects incomplete output and supports explicit output/reasoning budgets without silently changing models.
---

# DSH CLI Runner

Use the installed DeepSeek Harness as a transport to the requested model. Running
through DSH does not make that model DeepSeek or establish model-family independence.
If already running in DSH, prefer the host's native task facilities.

## Dispatch

Requires Python 3.10+ and DeepSeek Harness Desktop **0.2.1-rc.2** using its
installed macOS `dsh` launcher. Resolve `dsh` on PATH, or select that executable
with `--cli-entry`. The runner checks the public version/profile schema in a
fresh `DSH_HOME` and binds the launcher, application archive, Electron executable
and runtime metadata by hash. Other versions or installation layouts are refused;
it does not install or upgrade DSH. `--node-bin` is no longer an input: the desktop
launcher supplies its own execution runtime. A source checkout is not an installed
runtime.

Before dispatch, fix the task scope, acceptance criteria, time budget and output
budget. Put the question and relevant source in a UTF-8 prompt file; for independent
review, omit the author's conclusions and other reviewers' reports. This runner
performs one attempt with no model fallback or provider retries.

Provide a JSON object containing **one provider profile**, rather than a whole DSH
configuration. Use the installed catalog or current provider documentation for its
endpoint, model capacities and supported reasoning levels. For example, a catalog
route whose model needs no overrides can use:

```json
{
  "apiKeyEnv": "SELECTED_PROVIDER_API_KEY",
  "models": [{"id": "selected-model-id"}]
}
```

Export the referenced credential in the calling environment without printing it.
Only credential references belong in files; inline credentials and headers are
unsupported. This runner never reads or copies the user's managed credential
store. An authorized caller may resolve exactly the selected reference outside
the runner. Do not copy all credentials or send inputs to an unrequested provider.

```bash
bash /path/to/dsh-cli-runner/scripts/run_dsh.sh \
  --provider selected-catalog-route \
  --model selected-model-id \
  --provider-config-file /absolute/path/provider.json \
  --system-prompt-file /absolute/path/system.md \
  --prompt-file /absolute/path/task.md \
  --out /absolute/path/fresh-result.md \
  --timeout-secs 600
```

The deadline above is an example; choose it for the actual task. It must be finite
and positive. `--system-prompt-file` is optional. `--dry-run` checks inputs and writes
the dispatch configuration and receipt without a model request or requiring a key.
It invokes DSH only for version and profile-schema probes.
It does not establish provider availability. Output paths must be fresh; previous
deliveries are never overwritten.

## Isolation and capture

The runner invokes `dsh --profile headless --patch <generated-overlay> <task>` using
an argv list, without shell evaluation. DSH's headless interface takes a positional
task; it has no prompt-file flag. The wrapper reads the file and supplies it as one
argument with a `Task:` prefix. If argv/environment exceed the platform budget,
it refuses before dispatch. Split the task explicitly; never trim source silently.

Each call has a fresh working directory and `DSH_HOME`, under
`OUT.attempts/run.*` (or `--trace-dir DIR`). Only an explicit infrastructure allowlist remains enabled. Model tools,
ambient instruction/skill loaders, settings/credential stores, auxiliary title
generation, telemetry and unknown profile rows are disabled. Task inputs must be embedded in the prompt. The host may still add its runtime
snapshot of the fresh empty working directory; this is recorded in the raw session,
not represented as supplied research evidence.
Workspace tools, file-writing tasks, custom plugins and automatic continuation
are outside this runner's interface. Tool isolation is not an OS sandbox.

Retained evidence includes stdout/stderr, a plaintext uncompressed session log,
the exact dispatch configuration, input hashes, runtime identity, requested route,
effective request configuration, response metadata and a terminal receipt. These
files contain prompts and model reasoning; keep them in an authorized private
location outside the source repository. Receipts never include credential values.

Exit 0 requires all of: a successful child exit, exactly one fresh root-session v4 log (`session.v4.jsonl`) with contiguous events
and the isolated working directory, exactly one request with the selected route
and no exposed tools, one normal completed turn, current provider replay metadata
and a matching normal stream finish, one nonblank committed final assistant message,
and stdout equal to that entire final text. Failed attempts or retry records are
refused. Runtime bytes are rechecked and the deadline is checked again before
atomic output publication. Earlier committed messages and streaming chunks remain
in the raw log; `--out` is the final message, not a concatenated transcript.
The receipt's configured route/response ID are transport observations, not an
independent attestation of upstream model weights. Completed execution does not
establish the substantive correctness of a review or calculation.

Failure leaves `--out` absent. Usable stdout stays in the run's `output.partial`,
and raw records remain available even if only reasoning was produced. Timeout or
cancellation terminates the locally created process group; remote provider
cancellation is not attested. Exit 1 denotes failure/preflight refusal; argument
syntax errors use argparse's exit 2. No failure or unavailable review counts as a pass.

## Output limits

`--max-tokens N` explicitly sets the selected model entry's `maxTokens`, which DSH
uses as a request default. Verify the effective value in the receipt. Catalog
capacity metadata alone is not proof of a request budget or actual emitted length.
`--reasoning LEVEL` requires that level in the selected model's explicit
`reasoningEfforts` map and configures the provider default. Do not guess supported
levels or silently lower them. Provider usage may include reasoning tokens.

Client-side caps can be raised within the provider's supported limit; service-side
hard limits cannot be bypassed by this wrapper. A `max-tokens`/length terminal,
transport termination and deadline are distinct failures. Partition large tasks
into independently complete inputs with an explicit coverage list and bounded
call count. Do not call a partial response complete. The installed headless CLI supports `--session-id`, but this runner deliberately
creates one fresh session per bounded task and accepts no resume option. A
continuation needs a separately verified session workflow and the original task's
remaining budget; a session handle does not preserve process-local tool variables.

The runner is independently usable. Adding it to a skill catalog does not register
it as a review-swarm backend or install it into a running host.

Primary API references: [DSH CLI](https://github.com/deepseek-ai/deepseek-harness/tree/master/apps/cli),
[headless driver](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/bundle/headless),
[pi-ai adapter](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-pi-ai/README.md).
The installed version and public profile/session contracts define this wrapper's
executable contract; a source checkout or an upstream page may describe another
version. Hook bridge code in another checkout is not evidence that the installed
profile contains or enables it.
