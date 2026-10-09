# Lightweight Agent Eval

A small JSON-in/JSON-out evaluator that runs the local workspace version of `ClineCore`. It is designed for one common workflow: seed a case with several earlier user/assistant turns, send one final prompt, and capture Cline's result and usage in a machine-readable report.

This uses the SDK instead of spawning and scraping the terminal CLI. `initialMessages` preserves the supplied conversation history exactly, while each case still gets an isolated Cline session.

## Custom model request headers

Use `defaults.headers` for non-secret header values and `defaults.headersEnv` for server-side environment variable references. Cases can override either source by header name (case-insensitive). The same configuration works in CLI suite files, JSON/JSONL imports and the Web UI. See [examples/custom-headers.json](examples/custom-headers.json) for a complete example; replace its sample gateway URL and model before running it.

```json
{
  "headers": {
    "x-session-id": "{{sessionId}}",
    "x-message-id": "{{evaluationId}}"
  },
  "headersEnv": { "Authorization": "EVAL_AUTHORIZATION" }
}
```

Set `EVAL_AUTHORIZATION` securely in the environment of the CLI or Web server **before startup**, to the complete header value including any required `Bearer ` prefix. Workers inherit this environment. Do not paste credentials into suite files or the browser: credential headers such as `Authorization` and `x-api-key` require `headersEnv`. Missing/empty variables fail the case before a model request. Values are resolved only at execution time; stored configurations and snapshots retain the variable names.

In **运行配置** and **案例配置**, add rows under **自定义模型请求头**, choosing **固定值** or **环境变量**. The separate **案例请求头覆盖** section takes precedence over default rows, including when changing the value source. Removing a case override restores inheritance; empty objects do not delete inherited headers. An empty literal value is supported.

Literal values support `{{sessionId}}` (the SDK session ID shown in result details), `{{caseId}}` and `{{evaluationId}}` (a new UUID per case execution, including repeats and reruns). A full-task's successive model calls reuse these values. Thus `x-message-id: {{evaluationId}}` identifies an evaluation execution, **not each HTTP request or retry**. Environment variable values are not templated.

OpenAI-compatible endpoints support explicit `Authorization` overriding the API key header; other providers keep their SDK authentication behavior. `apiKeyEnv` remains available. Transport headers such as `Host`, `Content-Type` and `Content-Length`, invalid names/values, unknown templates and duplicate names within one layer are rejected. No CLI `--header` flags or request-body/query parameters are added.

## Replay modes and web workflow

- `single-turn` (also used when `replayMode` is omitted): one model response with tools disabled, regardless of inherited tool or iteration settings.
- `full-task`: the Agent can call the configured tools and continue until completion or the iteration limit. Set this explicitly for cases that read or modify files. History is initial context, not a sequential conversation script.

In the web UI, import cases from **案例集 → 导入案例** and create evaluations from **评测批次 → 新建评测**. Module/selected-case evaluation actions open the same evaluation form with the scope preselected. The import page includes field types, required conditions, examples, and JSON/JSONL templates. Its fallback replay mode applies only to cases without an explicit mode.

Case execution settings override file defaults, which inherit global settings at import/creation time. Single-turn tool and iteration constraints always take precedence. Multi-turn fixture directories are copied into isolated workspaces; single-turn runs use an empty workspace.

- **案例集**: filter by module, replay mode, or recent result. Selecting cases reveals batch actions; selection is preserved when changing filters.
- **案例编辑**: switch between 输入, 判定规则, and 配置 without losing unsaved fields. The result panel keeps assertions next to the output.
- **session_id**: shown only in detail views, not in case lists. Case detail headers show the latest recorded execution's session ID; execution history shows each round's ID, and result panels show the selected execution's ID. Missing IDs appear as `—`. Search cases by their latest session ID; CSV exports include `session_id`.
- **删除案例**: delete from the case list or editor after confirmation. Deletion permanently removes the saved case, while submitted executions, historical results, exports and reruns from snapshots remain available. API: `DELETE /api/cases/:id` (with `Content-Type: application/json`).
- **新建评测**: select cases, configure the run, then review each case's effective model, replay mode, tools, iteration limit, and timeout before starting.
- **批次详情**: filter results and inspect cases alongside the list. Live updates preserve selection and scroll position. Input snapshots, tool traces, and file artifacts have separate views; file comparisons include deleted files and can be expanded.

Pass rate is calculated over judged cases only (`passed / (passed + failed)`); execution errors and cancellations are reported separately. Cumulative execution time sums case durations, and missing cost data is displayed as unavailable. Global setting changes do not retroactively alter saved cases.

### Repeated batch evaluation

Set **新建评测 → 运行配置 → 重复轮数** (1–100, including the first execution; default 1). The review step displays cases × rounds and the total execution count. Each round completes before the next starts, with the configured concurrency within a round. Every execution uses the saved prompt/history/configuration snapshot and a separate session and workspace. Stopping a batch cancels pending repetitions as well. On a finished batch, **重复评测本批次** creates a new batch from its original snapshots; **重跑未通过案例** selects each affected case once even if it failed in several rounds.

**批次详情 → 多轮报告** shows per-round pass rates, cases that passed every round, pass/fail fluctuations, distinct output counts, and text consistency (most frequent output / compared outputs). Expand a case to compare complete outputs and assertion failures across rounds; the results list also filters by round. **导出简报** downloads a brief Markdown report, JSON includes `repeatReport` plus all raw results, and CSV includes round numbers, output text and failed assertions.

Output comparison includes only judged executions with complete results, normalizes line endings and trims outer whitespace; fewer than two outputs is insufficient for a consistency score. Errors, cancellations and pending executions are separate from pass/fail rates, and unfinished reports are labeled partial. Output changes alone do not establish hallucinations. Add factual `contains`, `notContains` or `matches` assertions and inspect the original responses; a case without content assertions only checks its finish reason. These reports do not use an additional model judge.

API: `POST /api/runs` accepts `repeatCount`; `parentRunId` with `rerunScope: "all"` repeats all original cases (the default rerun scope remains failed/error/cancelled cases). Historical batches without repetition fields are treated as one round. `GET /api/runs/:id/export?format=markdown` exports the brief report.

## Run it

### Task outcome grading (SPEC-001 A)

In **案例详情 → 判定规则**, enable **任务结果验收**, add result rules and mark required conditions. Files, UTF-8 text, JSON Pointer fields (strict equality, containment and numeric tolerances), unchanged-file hashes, registered acceptance commands and structured verifier scripts are supported. Required rules must all pass; verifier faults and missing evidence remain separate from acceptance failures. Optional diagnostics do not change the verdict. JSON advanced editing is also available.

Cases without `grading` retain the original text/finish-reason semantics. Task rates are grouped by case and grading version; legacy text rates, execution errors, coverage and cancellation counts are shown separately. Case details link each rule to its expected/actual values and evidence; CSV, JSON and Markdown exports retain grading metadata. List views show neither internal case IDs nor session IDs.

**SDK boundary:** this release does not modify the SDK. Its existing tool-start event can also describe a blocked attempt. All live tool/approval grading capabilities are therefore explicitly unsupported. Required behavior rules are rejected before creating a run; optional rules report insufficient evidence. The independent behavior checker is tested with synthetic, causally ordered events; that does not claim live approval coverage.

Register trusted verifiers using an evaluator-owned JSON file:

```powershell
$env:EVAL_VERIFIERS_FILE = (Resolve-Path examples/grading/verifiers.json).Path
bun run web
# Or use the same grading pipeline from the CLI:
bun run eval examples/grading/suite.json --output results/grading.json
```

Configure the model/provider credential as usual before a real run. [The sample suite](examples/grading/suite.json) asks the Agent to create a JSON file; [the verifier](examples/grading/verify-summary.ts) independently checks the file. It does not accept a verbal claim of completion.

Registry fields: unique `id`, `label`, `version`, `command` (absolute executable path, or `{runtime}` for the current runtime), `args` (array, never a shell string), `files` (verifier files/dependencies to fingerprint), `env` (explicitly permitted environment-variable names), and `timeoutMs` (default 60000, maximum 180000). `{verifierDir}` resolves relative to the registry; `{workspace}` and `{context}` resolve per verification. Scripts receive `EVAL_CONTEXT`, containing a disposable workspace path, execution result, rule and evidence index. Keep verifier files outside the Agent fixture. Restart the Web server after changing registry configuration.

Script stdout must be one JSON object: `{ "protocolVersion": 1, "verdict": "pass", "expected": ..., "actual": ..., "message": "...", "evidence": [] }`. Evidence entries reference registered evidence IDs. Exit 0 plus valid JSON is required for script judgments; nonzero exit, malformed protocol, truncation or timeout is a verifier error. For `command` rules, an unexpected exit code is an acceptance failure. Use a script wrapper to distinguish test failures from framework faults where necessary.

Evidence is frozen after the execution worker exits. Each command/script receives its own copy; verification cannot alter the original snapshot through normal workspace operations. These directories are **not an OS security sandbox**: trusted cases/verifiers are required, and adversarial isolation requires separate OS controls. Snapshot limits are 5000 files / 100 MiB; text/JSON checks accept up to 1 MiB, evidence previews up to 1 MiB. Excluded fixture directories remain `.git`, `node_modules`, `.cline`, `.eval-data`; dependencies must be provided by the verifier environment. Truncation or unavailable evidence never silently passes a required check.

Web artifacts live under `EVAL_DATA_DIR/runs` as before. New CLI grading runs use `<suite directory>/.eval-data/runs` by default (`EVAL_DATA_DIR` overrides it), print the isolated workspace path, and use an empty workspace unless `cwd` is configured. The run directory and fixture cannot contain one another. Old CLI cases keep their original cwd behavior. New grading exit codes: 0 all pass, 1 an explicit failure, 2 otherwise execution/verification error or inconclusive; full error details remain in the report. Regrading and model judges are not included in this phase.

Validation: `bun run typecheck`, `bun test`, `bun run smoke:web`. The process-tree test requires Windows permission to terminate the test process tree: `$env:EVAL_PROCESS_TREE_TEST='1'; bun test src/grading/integration.test.ts --test-name-pattern 'Windows verifier timeout'`.

Windows PowerShell (from this directory):

```powershell
$env:CLINE_API_KEY = 'your-key'
bun run eval examples/basic.json --output results/basic.json
```

## Build and package

Use Bun 1.3.13. From the repository root, `bun install --filter '@cline/example-agent-eval' --ignore-scripts` installs the example's dependency closure without running repository hook setup. Then run `bun run build:sdk`.

From `apps/examples/agent-eval`:

```powershell
bun run test
bun run typecheck
bun run package
```

The timestamped `release/` directory contains a `.tgz` archive and an unpacked `package/` folder. The release includes the local SDK packages under `vendor/`; it does not embed credentials or third-party dependencies. After extraction run `bun install --production --ignore-scripts` and `bun run start --help`. See `README.release.md` for Chinese usage instructions. This is a JavaScript distribution, not a standalone executable.

To verify an extracted release after installing its dependencies, run `bun run smoke:release <absolute-package-directory>`. This starts a loopback-only mock provider, verifies that prior history and the current prompt reach the real packaged SDK, and stores test session state in a temporary directory. No real LLM credentials or requests are used.

## Run from source

From the repository root:

```bash
bun run build:sdk
cd apps/examples/agent-eval
CLINE_API_KEY=sk_... bun run eval examples/basic.json --output results/basic.json
```

You can also use credentials already supported by your provider. To read a key from a specific environment variable, set `defaults.apiKeyEnv` or pass `--api-key-env NAME`.

The JSON report is printed to stdout. Progress and optional streamed model text go to stderr, so the report can be piped into another program safely.

## Input format

For 20 provider-neutral suites that can be pasted directly into the Web import flow, plus Chinese tables and examples for every result and behavior rule, see [`examples/README.md`](examples/README.md).

```json
{
  "version": 1,
  "defaults": {
    "providerId": "cline",
    "modelId": "anthropic/claude-sonnet-4.6",
    "apiKeyEnv": "CLINE_API_KEY",
    "cwd": "../../../../",
    "tools": "read-only",
    "maxIterations": 10,
    "timeoutMs": 300000
  },
  "cases": [
    {
      "id": "uses-prior-context",
      "history": [
        { "role": "user", "content": "Always use Bun in this repository." },
        { "role": "assistant", "content": "Understood." }
      ],
      "prompt": "Which package manager should I use?",
      "assertions": {
        "contains": ["Bun"],
        "notContains": ["npm"],
        "matches": ["Bun"],
        "finishReason": "completed"
      }
    }
  ]
}
```

`history` is optional and accepts prior `user` and `assistant` messages. The current turn belongs in `prompt`. Relative `cwd` values are resolved from the input JSON file's directory, making suites portable.

Assertions are optional. A case always checks for `finishReason: "completed"`; when assertions are present, all of them must pass. The process exits with code `1` when any case fails and `2` for invalid input or setup errors.

## Tool safety

- `none`: no built-in tools; useful for conversation-only checks.
- `read-only` (default): only file reading and code search are enabled.
- `full`: runs in Cline's unattended/yolo mode and may execute commands or modify files. Use an isolated disposable workspace.

Per-case settings override `defaults`; CLI flags override both. Run `bun run eval --help` for all flags.

## Report contents

Each case records the final text, finish reason, duration, iteration count, token/cost usage, compact tool-call records, assertion results, and Cline session ID. The report summary aggregates pass/fail counts, duration, tokens, and cost.
