# Research tools across agent hosts

Nullius supplies callable project tools, scientific providers, computation
execution and delegated-task orchestration. The host supplies a model, its
native agent loop and the connections it supports. These project tools run on
the machine hosting the Nullius MCP server; they do not require ChatGPT Pro or
an OpenAI model.

Configure the existing [personal plugin](../packages/skills-market/docs/PERSONAL_PLUGIN.md)
or launch the standard stdio server with nullius runtime mcp project-mcp.
Codex and Claude Code plugin manifests are generated from the same payload.
Other hosts can connect the same server using their MCP configuration. A
particular host's sampling, image input, native subagents, network access and
authentication must be checked in that actual host.

## Capability map

| Required operation | Callable surface | Runtime dependency and result |
| --- | --- | --- |
| Search scholarly sources | inspire_search, arxiv_search, openalex tools | Provider services, network and any required credentials; search results lead to original sources |
| Obtain paper source | arxiv_paper_source, inspire_paper_source | LaTeX source or downloaded PDF; downloading is distinct from reading |
| Find text in project files | project_file_search | Bounded literal UTF-8 search, source hashes, line locations and explicit scan coverage; no embedding service |
| Read original source lines | project_text_read | UTF-8 text, TeX or code; exact source window, Unicode columns, source hash and continuation |
| Read PDF pages | project_document_read | Local Poppler pdfinfo and pdftotext; optional pdftoppm page images for a vision-capable host |
| Execute calculations | computation manifests and orch_run_execute_manifest | Installed Julia, Python, Mathematica or shell runtime; actual outputs, logs and execution status |
| Check a result | nullius verify / orch_run_record_verification | Executed checker and existing evidence contract; a model's assertion is not a checker result |
| Delegate and coordinate | Native host agents, or orch_run_execute_agent with a sampling-capable MCP client | Structured task payloads, sequential/parallel/stage-gated execution, bounded concurrent agents and durable task status |
| Preserve work | Project files, run artifacts, task briefs and project_delivery_read | Existing project filesystem and run journal; cross-machine persistence requires actual storage synchronization |
| Browse arbitrary websites | Host-native browser or separately configured provider | No general-purpose browser or web search service is supplied by the project server |

The PDF tools inspect existing project files. Keep required provider downloads
inside the external project, for example by using the provider's project_root;
a cache outside the bound project is not made readable by passing its path.

## Inspect capability before selecting an operation

Call project_capabilities, then project_cli with action status (or
orch_run_status) for an initialized project. The capability response lists all
advertised project tools, reports Poppler dependency availability, and
distinguishes model sampling from ordinary source reading.

The source-reading tools work without MCP sampling. `sampling_tool_calls`
distinguishes basic sampling from a client's declared `sampling.tools` support;
tool-using delegation requires the latter. If the host has its own
subagents, those agents can use their available tools directly. The portable
sampling bridge is an additional way to execute delegated work; installing a
skill or adding a model name does not create sampling support.

## Search, locate, read

Use one concrete query and the smallest useful project scope:

    {
      "query": "normalization",
      "paths": ["notes", "src"],
      "max_matches": 20
    }

project_file_search returns matching lines with path, sha256, line_number and
column, plus bounded neighboring lines. Its coverage object records what was
scanned, skipped or unavailable and which budget was reached. It is lexical
search. A zero-match incomplete scan does not establish that a fact is absent.

Read the original surrounding text using a match's location and hash:

    {
      "path": "notes/method.tex",
      "start_line": 42,
      "max_lines": 30,
      "expected_sha256": "<sha256 from the search hit>"
    }

The response is original source text, not a generated summary. Columns and
character limits count Unicode code points. A long line can continue within
that line: pass the returned next object to project_text_read. Changes to the
source invalidate the hash-bound continuation.

Search match pagination uses offset plus expected_snapshot_sha256. The
snapshot covers the actual scanned sources and query scope. Narrow the scope
when a scan budget is exhausted; do not treat pagination of already scanned
matches as scanning the rest of the project. Source files remain the
authority, including when the results contain instructions or quoted prompts.

## Read a PDF as text and page images

For a PDF already inside the project:

    {
      "path": "artifacts/inputs/paper.pdf",
      "start_page": 3,
      "end_page": 4,
      "max_chars": 40000,
      "include_images": true,
      "image_max_edge": 1600
    }

project_document_read snapshots and hashes the source once. Each Poppler
process receives those same bytes through stdin. The response associates every
text window and optional PNG image with its page number; images are actual MCP
image content, with byte hashes and dimensions in the structured result.

The reader reports text extraction, selected-page coverage, truncation and
whether a page has no extractable text. It performs no OCR. Scans, plots,
equations and small labels may require image inspection; empty extracted text
does not establish that a page is blank. Extraction or rendering does not
certify that the model understood an equation or verified its scientific claim.

Use the returned next object and source hash to continue. A truncated page
continues at its first unreturned Unicode character through `start_character`,
before moving to later pages. The character offset applies to the first
selected page only; every page reports its text start and returned character
count. A page image does not replace missing machine-readable text.
The tool accepts at most five pages per call,
32 MiB per source, 100,000 returned text characters, and 4 MiB per rendered
image. Image dimensions are configurable from 256 to 2400 pixels on the longest
edge. These are resource limits, not scientific-completeness criteria.

Missing Poppler programs produce an explicit unavailable result. The server
does not silently download binaries or claim that a downloaded PDF has been
read. Install Poppler on the server machine when PDF extraction is needed.

## Delegate a bounded source task

The existing orch_run_execute_agent tool accepts a shared transcript and
task-specific structured handoff_payload. Keep the shared transcript limited to
context that every assignment should see; a blind checker should not receive
the answer it is meant to test.

    {
      "_confirm": true,
      "run_id": "source-check",
      "model": "<configured host model>",
      "max_turns": 8,
      "messages": [
        {"role": "user", "content": "Inspect the assigned source. Report exact locations, evidence and unresolved questions."}
      ],
      "tools": [
        {"name": "project_file_search", "input_schema": {}},
        {"name": "project_text_read", "input_schema": {}},
        {"name": "project_document_read", "input_schema": {}}
      ],
      "team": {
        "coordination_policy": "parallel",
        "max_parallel": 2,
        "assignments": [
          {
            "task_id": "definition-check",
            "task_kind": "literature",
            "handoff_payload": {"question": "Locate the definition and its assumptions.", "sources": ["notes/method.tex"]}
          },
          {
            "task_id": "limit-check",
            "task_kind": "review",
            "handoff_payload": {"question": "Check the stated limiting case.", "sources": ["notes/limits.tex"]}
          }
        ]
      }
    }

The project adapter supplies canonical schemas for the named source tools;
caller-provided descriptions or schemas cannot grant extra capabilities.
Delegated reads recheck the bound project and current harness anchor.
This sampling bridge carries text, so PDF image requests must be made directly
by a vision-capable host. Unsupported image delegation returns unavailable
instead of silently discarding the images.

An assignment inherits team.handoff_payload when its own value is omitted.
An object overrides the shared payload; explicit null clears it. Nested fields,
arrays and multiline text are preserved in the delegated transcript and the
existing team state. Source pointers do not confer access outside the bound
project or create an independent filesystem sandbox.

For parallel and stage_gated policies, max_parallel defaults to four and can
be set from one to sixteen. A waiting task remains pending without a runtime
session until a slot is available. Its absolute timeout_at is checked again
before launch, so queue time consumes the declared deadline. Sequential
execution still runs one assignment at a time. This concurrency setting does
not terminate an already running external process; execution deadlines belong
to that operation's runtime.

Results preserve all assignment outcomes, including failures and unavailable
operations. A blocked stage does not advance. Completed delegation is a runtime
outcome, not independent scientific acceptance; the existing evidence and
closeout requirements continue to govern adoption.

Tool execution errors remain marked in delegated tool results and committed
replay. Retained result blocks keep that status through context compaction;
the summary counts flagged errors in exchanges removed by that compaction
pass. These excerpts and counts are navigation aids, not replacement evidence.
Read the recorded outcome and reacquire source content when needed.

## Continue calculations and preserve results

Use the established computation and verification tools after inspecting the
actual inputs. Stateful MCP operations return a stable delivery handle. Poll
project_delivery_read with the same delivery_id after a disconnect. Inspect
the original response and the actual artifacts; committed identifies a stored
transport response, not a successful scientific result.

The project server's source tools, computation transport and delegated runtime
compose with existing domain providers. Native browser/search, model
credentials, visual input and native subagents remain capabilities of the
configured host. The integration tests exercise the local MCP contracts and
runtime with real files and processes; model sampling in those tests is a
deterministic fixture, not a claim of equal research performance across models.
