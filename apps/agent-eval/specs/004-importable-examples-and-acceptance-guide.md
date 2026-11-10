# SPEC-004：可直接导入的完整示例与验收方式说明

- 状态：**Implemented / 已实施**
- 确认记录：2026-09-21，用户确认将全部面向用户的现有案例整理为可直接导入的 JSON，并汇总结果与行为验收方式。
- 日期：2026-09-21

## 1. 目标与范围

1. 将 `agent-eval` 当前面向用户的案例集中整理到 `examples/importable/`，可以直接通过 Web UI 的“导入案例”入口导入。
2. 覆盖现有示例 JSON 中的 17 个案例、`src/replay.ts` 的 2 个内置示例，以及 `multi-turn.ts` 表达的 1 个上下文案例，共 20 个唯一案例。
3. 用表格和完整片段说明最终回复、任务结果和工具行为三类验收方式。

测试、集成测试和 smoke 脚本中的内部 fixture 不属于用户案例，不纳入示例集。此方案不修改 SDK、判分 schema、判分实现或统计口径。

## 2. 文件布局与兼容性

- `examples/importable/single-turn.json`：单轮回答与历史上下文案例。
- `examples/importable/full-task.json`：可调用工具的完整任务案例。
- `examples/importable/grading.json`：无需额外验证器的结果判分案例。
- `examples/importable/registered-verifier.json`：依赖 `examples/grading/verifiers.json` 的注册验证器案例。
- `examples/README.md`：导入说明、案例索引和验收方式总表。

导入文件不固定模型供应商、模型 ID、密钥环境变量或服务端地址，导入时继承当前 Web 设置。案例保留自己的回放模式、工具范围、迭代上限、超时、文本断言和 grading 规则。既有示例文件继续保留，避免破坏 CLI 命令和发布包文档。

## 3. 多轮案例转换

`multi-turn.ts` 展示真实会话中连续发送三轮消息；案例导入格式只支持“历史上下文 + 当前提示词”，不重放历史任务。因此将前两轮已确认的信息写入 `history`，把第三轮问题写入 `prompt`，并在说明中明确它验证的是上下文回放，不等同于三次实时模型调用。

## 4. 验收方式说明范围

文档覆盖：

- 最终回复：`contains`、`notContains`、`matches`、`finishReason`。
- 任务结果：`file.exists`、`file.absent`、`file.unchanged`、`file.text`、`file.json`、`command`、`script`。
- 工具行为：`tool.count`、`tool.parameters`、`tool.order`、`tool.approval`，以及 `requested`、`started`、`completed` 和 `outcome` 的匹配含义。
- 状态语义：必要/可选规则，以及 `pass`、`fail`、`error`、`insufficient`、`skipped` 对最终 verdict 的影响。
- 当前能力边界：现有 SDK 不提供真实工具/审批证据，必要行为规则在运行前拒绝，可选行为规则只作为证据不足的诊断项。

## 5. 异常处理

- 所有导入 JSON 必须通过现有 `parseEvalSuite` 和 Web `parseImport`。
- 案例 ID 在完整示例集中不得重复，所有案例显式填写回放模式。
- 注册验证器案例可以直接导入，但运行前必须配置 `EVAL_VERIFIERS_FILE`；文档必须明确这一点。
- 示例不得包含密钥，也不得在导入时触发模型运行或覆盖现有案例。

## 6. 验收标准与实施步骤

1. 先添加失败测试，证明缺少 `examples/importable/` 时会失败。
2. 添加四个导入文件，测试 20 个预期 ID、唯一性、显式回放模式和继承 Web 模型设置。
3. 添加 `examples/README.md`，表格列出全部验收规则，并给出最终回复、文件/JSON、行为诊断和注册验证器示例。
4. 运行针对性测试、完整 `bun test`、`bun run typecheck` 和 `git diff --check`，记录结果后将状态改为 Implemented。

## 7. 实施与验证记录

- 新增四个 provider-neutral 案例集，共 20 个唯一案例；所有案例显式设置回放模式，保留原案例的工具范围、迭代上限、超时、断言和 grading 规则。注册验证器案例独立存放并标明运行前提。
- `multi-turn.ts` 的前两轮转换为已完成历史，最后一轮作为当前 prompt；文档明确这不是三次实时模型调用。
- 新增完整中文验收指南，覆盖最终回复、七类任务结果规则、四类工具行为规则、比较方式、验证器协议、状态聚合及当前 SDK 能力边界。
- 新增测试通过真实 `EvalStore.parseImport` 校验四个文件，检查 20 个预期 ID 唯一、原始 JSON 显式回放模式、不包含供应商配置、继承当前 Web 模型设置，并保护原案例的关键执行配置。
- TDD 记录：测试在 `examples/importable/` 不存在时先以 2 项失败；补齐示例后转为通过。审查发现工具范围和超时各有一处漂移，新增回归断言先复现失败，再修正案例并转为通过。
- `bun test`：42 通过、0 失败、1 个 Windows 进程树专项测试按平台条件跳过。HTTP 测试需要绑定 loopback；沙箱内最小 `Bun.serve({ port: 0 })` 稳定返回伪 `EADDRINUSE`，确认沙箱外可绑定后在允许 loopback 的环境完成全量测试。
- `bun run typecheck`：通过。
- `git diff --check`：通过。
