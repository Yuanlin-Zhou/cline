# Lightweight Agent Eval

A small JSON-in/JSON-out evaluator that runs the local workspace version of `ClineCore`. It is designed for one common workflow: seed a case with several earlier user/assistant turns, send one final prompt, and capture Cline's result and usage in a machine-readable report.

This uses the SDK instead of spawning and scraping the terminal CLI. `initialMessages` preserves the supplied conversation history exactly, while each case still gets an isolated Cline session.

中文启动配置说明见 [STARTUP.md](STARTUP.md)，包含 MongoDB / SQLite 选择、首次准备、环境变量、模型凭据、验证脚本和迁移步骤。

## MongoDB case and module storage

Set `EVAL_CASE_STORAGE=mongodb` to read and edit cases directly in MongoDB, including cases created by an external generator. Single-turn and full-task cases, tags, copies and moves use the same MongoDB catalog; evaluation history and immutable execution snapshots remain in SQLite. Prepare collections/indexes explicitly and use a replica set for transactions. Existing deployments default to SQLite and are never migrated automatically.

See [MongoDB setup, document contract and migration](docs/mongodb.md), [the sample document](docs/mongodb-case.example.json), and [Spec 008](../../../specs/008-agent-eval-mongodb-cases.md).

## Editing tags in the Web UI

Case and module forms show selected tags as removable chips. Click **＋ 新增标签**, enter one name, then click **添加** or press Enter. Click **选择已有标签** to search and select multiple existing tags, then **完成选择** to close the panel. Use × to remove a tag from the current form. Changes take effect when you save the case or module.

Cases reuse tags from active cases across active modules; modules reuse tags from active modules. A new tag becomes available elsewhere after saving. Names containing commas remain a single tag. Duplicate names are rejected, and modules allow up to 20 tags. Removing a tag affects only the current item. See [the specification](../../../specs/007-agent-eval-tag-editor.md).

## Copying and moving cases between modules

In the Web UI, select cases and use **复制所选 / 移动所选**, or open a saved case through its name or row and use **更多 → 复制到… / 移动到…** in the details. Copying lets you choose the saved version or unsaved draft; save draft changes before moving. List rows offer **运行** and a **更多** menu for copy, move and delete. Batch operations include selected cases hidden by the current filters.

Choose an active target module and review the preview before confirming. Copies retain all configuration and get a new identity with no execution history. Moves retain their identity and history, increase the revision, and change module ownership. Existing runs and historical reruns keep their original snapshots. Same-module copies use `-copyN`; cross-module collisions either stop the entire operation or use `-copyN` / `-moveN`. No existing case is overwritten.

A stale preview requires another review and confirmation. If a network interruption leaves the result uncertain, refresh and check the target module before copying again. The APIs are `POST /api/cases/transfer/preview` and `POST /api/cases/transfer`; see [the specification](../../../specs/005-agent-eval-cross-module-case-transfer.md) for request fields and concurrency rules.

## Custom model request headers

Use `defaults.headers` for non-secret header values and `defaults.headersEnv` for server-side environment variable references. Cases can override either source by header name (case-insensitive). The same configuration works in CLI suite files, JSON/JSONL imports and the Web UI. See [examples/custom-headers.json](examples/custom-headers.json) for a complete example; replace its sample gateway URL and model before running it.

```json
{
  "headers": {
    "x-session-id": "{{sessionId}}",
    "x-evaluation-id": "{{evaluationId}}",
    "x-request-id": "{{requestId}}"
  },
  "headersEnv": { "Authorization": "EVAL_AUTHORIZATION" }
}
```

Set `EVAL_AUTHORIZATION` securely in the environment of the CLI or Web server **before startup**, to the complete header value including any required `Bearer ` prefix. Workers inherit this environment. Do not paste credentials into suite files or the browser: credential headers such as `Authorization` and `x-api-key` require `headersEnv`. Missing/empty variables fail the case before a model request. Values are resolved only at execution time; stored configurations and snapshots retain the variable names.

In **运行配置** and **案例配置**, add rows under **自定义模型请求头**, choosing **固定值** or **环境变量**. The separate **案例请求头覆盖** section takes precedence over default rows, including when changing the value source. Removing a case override restores inheritance; empty objects do not delete inherited headers. An empty literal value is supported.

Literal values support `{{sessionId}}` (the SDK session ID shown in result details), `{{caseId}}` and `{{evaluationId}}` (a new UUID per case execution, including repeats and reruns). A full-task's successive model calls reuse these values. `{{requestId}}` generates a new UUID for each model HTTP send, including retries. All references within one request share that UUID. Configure the header name required by your service, such as `request_id` or `X-Request-ID`; this ID is independent of SDK message IDs. Environment variable values are not templated.

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

Set **新建评测 → 运行配置 → 重复轮数** (1–100, including the first execution; default 1). The review step displays cases × rounds and the total execution count. Each round completes before the next starts, with the configured concurrency within a round. Every execution uses the saved prompt/history/configuration snapshot and a separate session and workspace. Stopping a batch cancels pending repetitions as well. On a finished batch, **重复评测本批次** creates a new batch from its original snapshots; **重试未通过案例** retries selected latest failed executions within the same batch. Choose 断言失败, 执行错误, 无法判定 or 已取消 (one or several reasons); counts show affected cases and executions. Each failed round is selected separately.

**批次详情 → 多轮报告** shows per-round pass rates, cases that passed every round, pass/fail fluctuations, distinct output counts, and text consistency (most frequent output / compared outputs). Expand a case to compare complete outputs and assertion failures across rounds; the results list also filters by round. **导出简报** downloads a brief Markdown report, JSON includes `repeatReport` plus all raw results, and CSV includes round numbers, output text and failed assertions.

Output comparison includes only judged executions with complete results, normalizes line endings and trims outer whitespace; fewer than two outputs is insufficient for a consistency score. Errors, cancellations and pending executions are separate from pass/fail rates, and unfinished reports are labeled partial. Output changes alone do not establish hallucinations. Add factual `contains`, `notContains` or `matches` assertions and inspect the original responses; a case without content assertions only checks its finish reason. These reports do not use an additional model judge.

API: `POST /api/runs` accepts `repeatCount`; `parentRunId` with `rerunScope: "all"` repeats all original cases (the default rerun scope remains failed/error/cancelled cases). Historical batches without repetition fields are treated as one round. `GET /api/runs/:id/export?format=markdown` exports the brief report.

## Run it

### Task outcome grading (SPEC-001 A)

In **案例详情 → 判定规则**, enable **任务结果验收**, add result rules and mark required conditions. Files, UTF-8 text, JSON Pointer fields (strict equality, containment and numeric tolerances), unchanged-file hashes, registered acceptance commands and structured verifier scripts are supported. Required rules must all pass; verifier faults and missing evidence remain separate from acceptance failures. Optional diagnostics do not change the verdict. JSON advanced editing is also available.

Cases without `grading` retain the original text/finish-reason semantics. Task rates are grouped by case and grading version; legacy text rates, execution errors, coverage and cancellation counts are shown separately. Case details link each rule to its expected/actual values and evidence; CSV, JSON and Markdown exports retain grading metadata. List views show neither internal case IDs nor session IDs.

**SDK boundary:** this release does not modify the SDK. Its existing tool-start event can also describe a blocked attempt. All live tool/approval grading capabilities are therefore explicitly unsupported. Required behavior rules are rejected before creating a run; optional rules report insufficient evidence. The independent behavior checker is tested with synthetic, causally ordered events; that does not claim live approval coverage.

Upload a UTF-8 `.js`, `.mjs` or `.ts` script (up to 1 MiB) in **案例详情 → 判定规则 → 使用验证脚本 → 上传验证脚本**. Uploading saves the script and selects it immediately, without administrator registration or a server restart. The same card includes input/result field documentation and two downloadable, runnable templates. See [the upload guide](docs/uploaded-verifiers.md).

Uploaded scripts follow `EVAL_CASE_STORAGE`: MongoDB uses `agent_eval_verifiers` in the case database; SQLite uses the existing records store. Run submission freezes the referenced source and hash in SQLite execution snapshots. Accepted runs and snapshot reruns can therefore execute without the MongoDB script library. Do not upgrade the MongoDB driver beyond the tested 6.21.0 without verifying Bun compatibility.

Existing trusted command/script registrations also remain supported using an evaluator-owned JSON file:

```powershell
$env:EVAL_VERIFIERS_FILE = (Resolve-Path examples/grading/verifiers.json).Path
bun run web
# Or use the same grading pipeline from the CLI:
bun run eval examples/grading/suite.json --output results/grading.json
```

Configure the model/provider credential as usual before a real run. [The sample suite](examples/grading/suite.json) asks the Agent to create a JSON file; [the verifier](examples/grading/verify-summary.ts) independently checks the file. It does not accept a verbal claim of completion.

Registry fields: unique `id`, `label`, `version`, `command` (absolute executable path, or `{runtime}` for the current runtime), `args` (array, never a shell string), `files` (verifier files/dependencies to fingerprint), `env` (explicitly permitted environment-variable names), and `timeoutMs` (default 60000, maximum 180000). `{verifierDir}` resolves relative to the registry; `{workspace}` and `{context}` resolve per verification. Scripts receive `EVAL_CONTEXT`, containing a disposable workspace path, execution result, rule and evidence index. Keep verifier files outside the Agent fixture. The Web list and new executions reload registry configuration without a server restart.

Script stdout must be one JSON object: `{ "protocolVersion": 1, "verdict": "pass", "expected": ..., "actual": ..., "message": "...", "evidence": [] }`. Evidence entries reference registered evidence IDs. Exit 0 plus valid JSON is required for script judgments; nonzero exit, malformed protocol, truncation or timeout is a verifier error. For `command` rules, an unexpected exit code is an acceptance failure. Use a script wrapper to distinguish test failures from framework faults where necessary.

Evidence is frozen after the execution worker exits. Each command/script receives its own copy; verification cannot alter the original snapshot through normal workspace operations. These directories are **not an OS security sandbox**: trusted cases/verifiers are required, and adversarial isolation requires separate OS controls. Snapshot limits are 5000 files / 100 MiB; text/JSON checks accept up to 1 MiB, evidence previews up to 1 MiB. Excluded fixture directories remain `.git`, `node_modules`, `.cline`, `.eval-data`; dependencies must be provided by the verifier environment. Truncation or unavailable evidence never silently passes a required check.

Web artifacts live under `EVAL_DATA_DIR/runs` as before. New CLI grading runs use `<suite directory>/.eval-data/runs` by default (`EVAL_DATA_DIR` overrides it), print the isolated workspace path, and use an empty workspace unless `cwd` is configured. The run directory and fixture cannot contain one another. Old CLI cases keep their original cwd behavior. New grading exit codes: 0 all pass, 1 an explicit failure, 2 otherwise execution/verification error or inconclusive; full error details remain in the report. Reference-based LLM scoring is available as described below; historical trials do not overwrite official results.

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

## 执行状态与会话记录

单案例调试和批次详情会显示当前阶段、运行耗时、最近收到的活动以及页面同步异常；正常同步不常驻提示。文本暂时不变不代表执行停止；工具通知与验证阶段可以继续推进。

“结果”优先展示判分和最终回复，实时文本预览默认折叠。“会话”按消息查看本次执行保存的用户输入、模型回复、工具请求与结果，可刷新、分页和下载 JSON。SDK 保存的是会话上下文，压缩后可能不含全部早期消息；缺失、清理或写入中的文件会有明确提示。工具诊断不能作为工具实际执行的判分证据。错误、取消和中断时仍保留已有输出。

会话默认跟随最新保存的消息；点击“最早消息”或“下一页”后暂停跟随，便于查阅早期内容，点击“最新消息”恢复。

## Python 自定义验证

在案例判定规则上传 `.py`，用 `verify(ctx)` 读取执行结果、结构化会话、产物和初始文件，自定义业务检查。页面提供模板、输入字段说明、历史结果试验证及日志。服务端需要 Python 3.10+，可指定 `EVAL_PYTHON_EXECUTABLE`；无需注册脚本或重启。参见 [Python 脚本指南](docs/python-verifiers.md) 和 [启动配置说明](STARTUP.md)。旧 JS/TS 脚本继续支持。


## 案例选择、复制和当前批次重试

- 案例集和新建评测的案例选择区支持 **Shift 连选**、鼠标从复选框开始纵向拖动、全选/反选。**选择操作** 中的全选/反选只作用于当前筛选结果；批量工具栏说明被筛选隐藏的已选项。
- 复制时先选择目标模块，点击 **编辑副本配置** 修改输入、判定规则、模型及运行配置，应用修改返回预览后再确认创建。批量复制可只勾选需要统一覆盖的配置字段；逐项编辑的副本优先。取消不会保存副本，原案例和其历史不会改变。有未保存内容时可明确选择使用当前内容或已保存版本。
- 已结束批次点击 **重试未通过案例**，勾选一种或多种原因：**断言失败 / 执行错误 / 无法判定 / 已取消**。弹窗显示各类数量和本次案例数、执行次数；例如只勾选“无法判定”即可只重试该类案例。也可在案例结果内重试单项。
- 重试使用原批次冻结的配置和验证脚本，在原批次中创建新的尝试，不读取案例库的后续修改。直接执行模式会再次操作原目录当前内容。运行中先等待完成或取消，再发起重试。
- 每个案例/轮次默认显示最新执行及 **重试 N 次**；详情下拉框切换首次执行与历次重试的结果、会话及产物。通过率和状态按最新执行统计；Token、费用和耗时累计所有尝试。多轮报告可切换首次执行与最新结果，重试不增加实验轮次。
- 结果顶部精简为任务验收/回复检查摘要和异常，规则版本、覆盖率及统计口径在 **详细统计与统计口径** 中查看；已结束执行的过程信息折叠到 **执行详情**。
- JSON 保留全部尝试并附最新项标识，CSV 增加 root_item_id、attempt、previous_item_id 和 is_latest。原 parentRunId 新建子批次 API 保留兼容；**更多 → 重复评测（新批次）** 用于另建独立实验；导出格式统一在 **导出** 菜单选择。


## LLM Judge：参考答案评分

在案例 **判定规则 → LLM 评分** 中填写参考答案，自选评审 **执行结果 / 执行轨迹 / 两者**，并配置独立 Judge 模型。默认输出 0–100 分、理由和原文依据，不影响原案例结论；可显式开启及格线。全局 Judge 默认模型在 **运行配置 → Judge 默认模型** 中单独保存，已有案例使用自己的快照。

支持历史执行 **预览送审材料 → 试评分**，仅调用 Judge，不重跑被测模型或修改原正式成绩。评分 Token/费用独立统计，失败或信息不足不填为 0 分。复制、导入、原批次重试及 JSON/CSV/Markdown 导出保留 Judge 配置和结果。

完整说明、模型凭据、材料边界、成本及 API 见 [LLM Judge 指南](docs/llm-judge.md)，可运行的 JSON 模板见 [参考答案示例](examples/llm-judge/suite.json)。已有 MongoDB 部署先运行 `bun run mongo:prepare` 更新校验器；未启用 Judge 的旧案例继续按原方式运行。

## 大案例集性能

案例列表与批次进度使用轻量摘要和增量同步，完整输入、输出和尝试历史按需读取。旧数据首次启动会自动备份并构建索引；升级前停止旧实例。迁移、回退、MongoDB 兼容和基准命令见 [性能说明](docs/performance.md)。


## 界面操作速查

- 批次详情优先显示结论和模型回复；结束后默认打开未通过项，手动选择不会被轮询打断。手机通过 **切换案例** 展开列表，选中后直接查看结果。
- **结果 / 会话 / 评分** 是常用视图，**更多视图** 包含输入与配置、工具诊断、文件产物、脚本试验证。无 Judge 配置时不显示空评分页签；结果页的 **查看依据** 打开完整评分。
- 案例编辑中 **保存案例** 显式保存，**运行草稿** 使用当前填写内容且不自动保存。判定规则按检查类型展开，切换页签和折叠配置保留填写内容。
- **运行配置** 分为被测模型、执行默认值和 Judge 默认模型。前两项共用保存范围并保留彼此字段，Judge 单独保存；自定义请求头按需展开。
- 同批次重试按原因选择，显示案例数与执行次数；只有多次尝试时出现历史下拉框。仅评分低分不表示断言失败，信息不足或评分错误不显示为零分。
