# SPEC-001：结果与行为判分

- 状态：**Implemented / A 阶段已实现（按第 14 节确认的 SDK 能力边界）**
- 日期：2026-09-16
- 依据：[内网评测 roadmap](../../../../agent-eval-intranet-roadmap.md) 的“结果与行为判分：核心设计”和 P0 判分条目。
- 本次实施范围：下文 A 阶段及第 14 节确认的调整；B、C 阶段分别确认后实施。
- 确认记录：2026-09-16，用户明确回复“确认，开始实施”，批准 A 阶段。

## 1. 目标和通过标准

让评测回答三个问题：任务是否完成，关键行为是否合规，结论依据是什么。

采用“必要条件全部满足”的验收方式：结果规则与关键行为规则必须全部通过。质量、耗时或 token 得分不能抵消关键失败。`finishReason: completed` 是执行信号，不能独自证明任务成功。

典型案例：要求生成统计 JSON，并且先读取输入文件。Agent 回复“已完成”，但文件不存在，应判失败；文件正确但未读取规定输入，应判行为失败；验证脚本自身崩溃，应单列验证错误。

## 2. 当前实现及影响

| 当前代码 | 现状 | 设计影响 |
|---|---|---|
| `src/assertions.ts` | 检查最终文本 contains/notContains/matches 和结束原因 | 保留旧规则，统一转换成新规则结果 |
| `src/runner.ts` | 执行与判分耦合；最终 toolCalls 缺少调用 ID；异常返回空轨迹 | 抽离判分并持续收集证据，异常也保留已发生事件 |
| `src/web/worker.ts`、`queue.ts` | 子进程发送文本/结果/错误；队列直接采用结果状态 | 增加证据消息和验证阶段，终态等待验证完成 |
| `src/web/workspace.ts` | Web 复制工作区并保存 baseline；文件差异按需读取；大文件 hash 是大小/时间标记 | 判分需独立的固定快照与真实内容摘要，不能直接采用预览摘要 |
| CLI 执行入口 | 直接使用解析出的 cwd，不具备与 Web 相同的工作区副本 | 新判分模式统一准备工作区，避免验证污染用户工程 |
| `src/web/types.ts`、`repeat-report.ts` | 状态混合执行结果与断言结果，通过率统计 passed/failed | 增加独立验证状态，统计保留分母和覆盖率 |

当前 SDK 源码存在工具开始/完成事件及 toolCallId 的适配逻辑；现有 runner 只订阅文本。真实请求、审批及执行之间的完整关联仍需接入验证，不能从最终 toolCalls 顺序推测。

## 3. 分阶段范围

### A：本次建议实现

1. 保留文本和结束原因断言。
2. 文件存在/不存在、文本包含/不包含/正则、JSON 字段、数值容差、指定文件保持不变。
3. 独立测试命令退出码，以及案例维护者提供的结构化验证脚本。
4. 工具名、参数、次数、禁止调用和局部先后关系断言；明确请求与执行的检查阶段。
5. 最小事件协议、执行前后文件证据、判分版本和逐项证据展示。
6. Web 规则编辑、详情展示、CLI/Web 相同的判分语义、JSON/CSV/简报导出、多轮报告适配。
7. 真实审批事件可关联时检查“批准后执行、拒绝后未执行”；能力不满足时阻止相关案例启动，并说明缺项。

### B：后续单独确认

基于归档证据重新判分、评分版本对比、业务服务状态采集器、复杂条件与恢复规则、Skill 使用检查、UI 自动化检查器。A 阶段允许通过受控验证脚本表达已能独立验证的业务检查，但不内置通用业务连接器。

### C：后续单独确认

内网模型裁判、人工复核和裁判校准。裁判只补充开放式质量；必须读取证据，输出分项分数与理由，单独记录用量与错误。

### 与其他 roadmap 项目的边界

- 本 spec 不实现完整审批/追问应答脚本、Agent 产品初始化改造、Skill/MCP 配置平台或 Windows 便携包。
- “审批被拒后仍执行”的检测器及合成事件测试属于 A；真实 Agent 端到端审批验收依赖实际审批入口及关联 ID。不能用 yolo 运行冒充已覆盖审批。
- 缺信息追问、用户回复后的续跑、语义上的虚假成功声明，需要后续交互与语义能力。首期只能按明确的文本规则与实际产物组合检查。
- 不新增通用工作流 DSL，不要求完整轨迹严格一致。

## 4. 执行与验证架构

```text
案例与规则校验 → 能力/依赖预检 → 固定规则和验证器版本
                                ↓
执行前文件基线 → Agent worker → 持续保存事件 → 执行结束/异常
                                                    ↓
                                  确认执行进程结束，冻结最终证据
                                                    ↓
                         内置规则 + 独立 verifier 子进程
                                                    ↓
                                  逐项结论 → 汇总 → 页面/导出
```

建议新增 `src/grading/`，包含规则解析、事件模型、结果检查器、行为检查器、进程验证器和汇总器。CLI 与 Web 调用同一层执行编排，避免维护两套判分逻辑。

验证器在 Agent 结束后读取证据；需要运行代码的检查在证据的独立副本执行。每个有写入可能的验证命令使用独立副本，防止验证顺序改变结果。验证日志和临时产物不计入 Agent 文件变化。

规则快照、正式验收脚本、预期数据与评分输出由评测器保存，位于 Agent 工作区之外。单独目录和独立进程不能提供 OS 级安全隔离：本地 A 阶段适用于受信案例；对抗性防篡改需受限账户或容器，不能声称仅靠路径分离即可保证。

## 5. 案例配置

新增可选 `grading` 字段，内部 `version: 1`，保留原有案例集 `version: 1` 和 `assertions`。

```json
{
  "id": "generate-summary",
  "replayMode": "full-task",
  "prompt": "读取 input.json，生成 summary.json，保留 config.json。",
  "grading": {
    "version": 1,
    "rules": [
      { "id": "output", "kind": "file.exists", "path": "summary.json" },
      { "id": "total", "kind": "file.json", "path": "summary.json", "pointer": "/total", "op": "equals", "expected": 12 },
      { "id": "config", "kind": "file.unchanged", "path": "config.json" },
      { "id": "read", "kind": "tool.count", "match": { "name": "read_files", "phase": "completed", "outcome": "success" }, "min": 1 },
      { "id": "acceptance", "kind": "command", "verifierId": "summary-tests-v1", "expectedExitCode": 0 }
    ]
  }
}
```

规则默认 `required: true`；可选诊断规则显式设为 false。每条有稳定 id、可选 label；同案例 id 重复、未知 kind/字段、不合法参数或空 rules 均在导入/保存时拒绝。`grading` 与旧 assertions 同时存在时，两者都执行，避免覆盖旧约束。

验证器以注册 ID 引用，服务端配置解析到维护者管理的执行文件、参数数组、版本与摘要；案例 JSON 不直接指定任意 shell 字符串或绝对脚本路径。首期只支持预安装验证器，不在 Web 中上传可执行脚本。

### 5.1 结果规则语义

| kind | 语义 |
|---|---|
| `file.exists` / `file.absent` | 相对工作区的指定普通文件存在/不存在 |
| `file.text` | UTF-8 文本 contains/notContains/matches；不隐式 trim 或忽略大小写 |
| `file.json` | 解析完整 JSON，以 JSON Pointer 选择值；支持 exists、equals、contains、approx |
| `file.unchanged` | 基线和最终文件均存在且 SHA-256 一致；新增、删除或改动均失败 |
| `command` | 评测器运行注册验收命令，比较进程退出码并保留日志 |
| `script` | 注册验证器返回约定的 JSON 结论，适合统计、关键记录和业务状态检查 |

JSON equals 使用类型严格的深比较，对象键顺序无关，数组顺序相关；contains 仅用于字符串包含或数组成员深匹配。approx 只接受有限数值，误差满足 `abs(actual - expected) <= max(absTolerance, relTolerance * abs(expected))`；至少显式提供一种非负容差。字段缺失与 null 分开。

预期文件缺失、JSON 无法解析、字段不符属于规则失败；检查器读取权限不足、快照损坏属于验证错误。路径不允许绝对路径、`..` 越界或链接逃逸。二进制支持存在/摘要检查，不做文本匹配。

预检检查验证器和工具链是否可用，不要求 Agent 应当生成的文件提前存在。单轮模式不能配置依赖工作区产物或工具行为的必要规则；导入时提示改用完整任务模式。

### 5.2 行为规则语义

| kind | 语义 |
|---|---|
| `tool.count` | 对匹配调用计数，min/max 定义必须调用、最大次数，max=0 表示禁止 |
| `tool.parameters` | 匹配工具调用后，对参数 JSON Pointer 检查 equals/contains/matches；默认至少匹配一次且全部匹配调用满足 |
| `tool.order` | 指定前置调用完成后才允许后置调用开始；逐一检查每个后置动作，不只寻找一对合规动作 |
| `tool.approval` | 每个受约束执行都有对应的允许审批，且该审批先于执行；明确拒绝后执行为失败 |

规则匹配器包含工具名、阶段、可选参数条件及 outcome。phase 必须显式选择 `requested`、`started` 或 `completed`。工具名精确匹配真实名称；模块名如 write_file 不自动当作 SDK 工具名。

次数按 toolCallId 去重；不同重试调用分别计数。completed 可以筛选 success/error；请求被拒不计入 started。顺序默认前置必须成功完成，允许中间出现无关探索；以调用关联和同一会话的事件序号验证，不依赖数组顺序或墙钟时间。

`tool.order` 默认要求至少一个后置动作；若业务允许没有后置动作，应显式配置 `requireAfter: false`。禁止规则在完整轨迹中没有命中可以通过；轨迹缺失或截断时不能因“没看到”就判通过。

## 6. 证据模型与接入约束

规范化事件最少包含：eventId、schemaVersion、sessionId、itemId、seq、timestamp、type、toolCallId、parentEventId（可选）、payload。

事件类型：session.started/ended、tool.requested、approval.requested/resolved、tool.started/completed、user.replied，以及执行异常。输入输出、审批结果与错误引用关联的调用。user.replied 首期预留，不伪造不存在的用户交互。

- 在 cline.start 之前订阅事件，先分配 sessionId，通过适配器按会话归档。
- 本仓库存在 CoreSessionEvent 与内部 agent_event 两层，实施时以锁定的本地 SDK 类型和真实事件探针为准。
- 记录能力清单：是否观察到请求、执行、审批以及关联 ID；不能用 tool.started 反推 tool.requested。
- 若 SDK 某事件实际表示“尝试调度”而不是“开始执行”，不得映射成 started；在真实执行边界补事件，必要 SDK 改动单独说明并遵循 spec 确认流程。
- 父进程持续落盘 JSONL，结束时写完整性清单；丢包、进程崩溃、超限、截断都标记不完整。
- 保留足够的完整最终文本和工具数据供判分；页面预览截断与证据截断分开。
- 脱敏在持久化和导出前进行；被脱敏字段不能继续按原始值做离线精确断言，相关规则给出证据不足。凭据使用引用，不作为预期答案。

调用成功只证明工具报告成功。业务状态成功必须由独立读取状态的脚本证明；保存读取时间、查询范围与实际响应，避免把工具返回文字当成最终状态。

建议目录：

```text
runs/<runId>/<itemId>/
  execution.json
  evidence/events.jsonl
  evidence/manifest.json
  evidence/baseline/              # 声明需要比较的执行前文件
  evidence/artifacts/             # 执行结束后的固定文件副本
  grading/<gradingId>/rules.json
  grading/<gradingId>/result.json
  grading/<gradingId>/logs/
```

manifest 记录文件摘要、证据范围、缺失项、事件完整性、环境与验证器版本。大文件按流计算摘要；超过归档限额须显式报告，不能静默忽略。A 默认沿用精简 fixture 边界（不自动复制 .git/node_modules），验收依赖由注册验证环境提供；需要缺失依赖的案例预检失败。

## 7. 验证脚本协议与运行边界

- 输入：由评测器生成的 context.json，包含只读证据路径、执行摘要、规则配置和协议版本。
- 启动：执行文件与 argv 数组，默认无 shell；环境变量白名单，允许的服务凭据单独配置。
- 输出：单个结构化 JSON，包含 protocolVersion、verdict（pass/fail）、expected、actual、message、evidence 引用；stderr 留作诊断。
- script 退出 0 且协议有效才接受 verdict；非零退出、非法 JSON、协议不符或超时 → 验证错误。
- command 的非预期退出码 → 测试失败；无法启动 → 验证错误。复杂工具的“测试失败/框架故障”无法单靠退出码区分时，使用 script 包装器明确分类。
- 默认每个验证器 60 秒、每案例验证总计 180 秒，可在受控配置中覆盖；验证超时独立于 Agent 任务超时。
- 默认日志预览 1 MiB，超限截断并标记；结构化结果必须完整，否则报验证错误。正则、文本和事件检查也受输入上限及验证超时约束。
- 取消和超时清理验证进程树，Windows 需测试子进程残留；不能只结束父进程。
- 验证器不可获得无关的 Agent API key。真实业务检查默认只读；会产生副作用的验证器不纳入 A。

Agent 任务预算超限与验证器超时分开：前者若为案例明确的硬预算，按必要规则失败；后者是判分基础设施问题。

## 8. 状态、汇总与兼容

### 8.1 三层状态

1. 执行：queued/running/completed/error/cancelled，另存 timeout 等原因；completed 表示执行终结，不代表任务通过。
2. 每条规则：pass/fail/error/insufficient/skipped，并附 expected、actual、message、evidenceRefs、durationMs。
3. 案例判定：passed/failed/inconclusive；验证生命周期：pending/running/completed/error/cancelled。

聚合顺序：有任何必要规则明确 fail → failed，同时保留其他验证错误；否则必要规则存在 error/insufficient/skipped 或规则尚未完成 → inconclusive；只有全部必要规则 pass 才 passed。可选规则不改变总判定。

没有必要规则不允许标为任务通过。新 grading 模式不自动把 completed 增补为“任务完成”条件；可以显式配置旧 finishReason 断言。用户拒绝后正确停止的案例可以通过行为约束成立。

运行异常仍尽可能验证已冻结证据；若已确定违规，可显示“执行错误 + 行为失败”。用户取消显示 cancelled，现有部分判分仅供诊断，不算完整样本。

### 8.2 统计口径

| 指标 | 分子 / 分母 |
|---|---|
| 已判定任务通过率 | passed / (passed + failed)，仅新 grading 模式、非取消的终态样本 |
| 全部任务成功比例 | passed / 所有已结束非取消的新模式样本，包含 inconclusive，避免隐藏无法判分 |
| 关键约束通过率 | 必要行为规则 pass / 必要行为规则已判定(pass+fail)；并列显示未判定数量 |
| 执行错误率 | execution.error / 已结束且非取消的全部执行样本 |
| 判分覆盖率 | 新模式所有必要规则均获得 pass/fail 的样本数 / 新模式已结束非取消样本数 |

分母为 0 显示“—”。取消、运行中、旧模式样本单列；重复评测按每轮 item 统计，并保留按案例“全轮通过”的汇总。不同规则版本不混算为同一通过率。效率优先对同案例、同规则版本且成功的执行比较。

### 8.3 旧案例兼容

- 无 grading 字段的案例保持现有行为和状态，标记“旧版文本判定”；历史报告不补算、不覆盖。
- 旧版通过率明确称为文本判定通过率，不与新模式任务通过率混合。
- 新结果保留现有 text、toolCalls、usage、assertions 字段；增加 execution、grading 和 evidence 元数据。
- 外层 ItemStatus 增加 inconclusive；运行时仍可使用 running，并通过 phase 展示“执行中/验证中”。执行错误与判分错误从独立字段读取，不能继续只靠一个 status 统计。
- 旧 assertions 的布尔结果投影仅用于旧规则展示；新规则 error/insufficient 不伪装为 passed=false。
- 新模式 CLI 采用 0=全部通过，1=存在明确失败，2=无明确失败但有执行/验证错误或证据不足；混合情况返回 1 并在报告保留全部错误。旧模式退出码保持原逻辑。
- CLI 旧案例执行目录不静默变化；启用 grading 的案例采用副本并在启动前明确显示路径。Web 继续使用副本。

## 9. Web 和接口

案例编辑“判定规则”分为结果、行为两组，支持添加规则、必要/可选、参数校验。注册验证器下拉选择，显示用途、版本与依赖；提供 JSON 高级编辑入口。新建案例提示设置实际验收目标，导入旧案例显示兼容模式。

案例列表保留现有简洁布局，用最近结果区分通过、失败、执行错误、无法判定；**不展示内部案例 ID 或 session_id**。

详情页“结果与断言”展示执行状态、总判定、必要条件完成数，以及逐条规则的“预期、实际、证据”。点击证据定位工具事件、文件字段或验证日志。session_id 继续只在详情视图展示。

批次详情和多轮报告增加验证覆盖率、执行错误与未判定数量；CSV 每次执行一行，增加判定、验证状态、失败规则 ID、证据索引；JSON 保留完整结构；Markdown 简报摘要不替代原始证据。

API 提议：

- 原案例创建/更新/导入接口支持 grading，并返回字段级配置错误。
- `GET /api/verifiers` 返回已注册验证器的非敏感元数据。
- 原运行详情返回 execution/phase/grading 摘要及 gradingId。
- `GET /api/runs/:runId/items/:itemId/grading` 获取逐项结果。
- `GET /api/runs/:runId/items/:itemId/evidence/:evidenceId` 获取受大小限制的证据；仅解析服务端登记的 evidenceId，不接受任意文件路径。
- 重新判分写接口留到 B，不在 A 提供空实现。

## 10. 归档与模型裁判的后续接口

A 保存规则版本、验证器摘要、案例修订、证据摘要与 gradingId，为 B 保留输入。重新判分只新建评分记录，不能修改原执行、原评分或重新调用 Agent。新增规则所需证据未被采集时显示 insufficient，不能读取当前业务服务状态冒充当时状态。命令重验还需匹配验证环境，否则无法保证复现。

C 的裁判请求固定模型部署、评分提示词、rubric 版本和证据选择策略；待评内容按数据处理。故障不记零分，低置信度进入复核；裁判费用独立累计。上线前使用人工标注集校准，不能凭模型给出的置信度代替校准。

## 11. 验收标准

| 编号 | 场景 | 预期 |
|---|---|---|
| A01 | 回复完成但没有要求的输出文件 | 结果失败，定位缺失路径 |
| A02 | 文件存在但 JSON 错误、字段缺失或类型错误 | 对应规则失败；null 与缺失可区分 |
| A03 | 数值恰在/超过容差边界 | 分别通过/失败 |
| A04 | 指定保护文件改动、删除；或两边都不存在 | unchanged 失败 |
| A05 | 两种不同正确实现、不同无关读取顺序 | 都通过，不绑定完整轨迹 |
| A06 | 正式验收测试失败与验证脚本崩溃 | 分别失败与验证错误 |
| A07 | 工具参数错、重复创建、禁止请求、禁止执行 | 各自正确判定并定位调用 |
| A08 | 请求被拒而没有执行 | 禁止执行通过，禁止请求可失败 |
| A09 | 写入先于批准、拒绝后仍启动工具 | 行为失败；先以合成事件验收，真实接入另注明依赖 |
| A10 | 查询开始后但尚未完成就修改 | 局部顺序失败 |
| A11 | 工具错误后按允许次数重试成功 | 无其他违规时可通过 |
| A12 | 超时/崩溃/事件缺失或日志截断 | 保留证据；不得凭缺失轨迹判禁止规则通过 |
| A13 | 验证器修改临时工作区 | 不改变原产物证据及其他检查结果 |
| A14 | 案例导入导出、保存修订与运行快照 | 规则不丢失，修改案例不改变历史运行 |
| A15 | 旧案例和旧报告 | 原结果不变，清晰标记兼容模式 |
| A16 | 多轮中包含失败、未判定、执行错误和取消 | 各项分母正确，无虚高通过率 |
| A17 | 路径越界、链接逃逸、秘密字段和过大结果 | 拒绝或明确受限，不泄露、不静默通过 |
| A18 | Windows 验证进程超时或取消 | 子进程清理完成，部分日志可查 |

每类关键检查准备“已知正确、典型错误、另一种正确实现”三组 fixture。行为判分先用确定性事件测试，再用本地模拟模型/工具链验证真实接入，不以真实模型随机输出作为单元测试条件。

## 12. 实施顺序与完成条件

1. 定义规则/状态/证据协议与旧规则适配，先写确定性检查器验收。
2. 文件、JSON、命令与脚本验证；统一新模式 CLI/Web 的快照和验证编排。
3. 事件采集、行为检查、错误时证据留存与能力预检；确认真实审批覆盖范围。
4. Web 编辑和证据展示、导出、批次与多轮统计适配。
5. 完成兼容回归和 Windows 模拟服务冒烟，更新 README、示例与本 spec 验证记录。

预计主要修改 `types.ts`、`schema.ts`、`runner.ts`、CLI 入口以及 Web worker/queue/store/server/client/repeat-report，并新增 grading 模块；SDK 如需补事件，先提交具体差异设计。

验证命令沿用 Bun 工具链：`bun run typecheck`、`bun test`、`bun run smoke:web`，并扩展判分集成测试。若修改 SDK，先在仓库根运行 `bun run build:sdk` 再验证。只在测试目录执行合成失败和副作用场景。

A 的完成条件：以上验收通过，报告可解释每条结论，兼容行为明确；对暂不支持的审批/交互能力显示真实限制，不能以预留字段或合成测试宣称已经具备完整审批评测。

## 13. 已确认决策

用户已确认以下组合，并在第 14 节明确 SDK 暂不修改：

1. 本次先实施 A，B/C 后续另开 spec。
2. 新判分默认所有规则为必要条件，采用全部通过，不引入综合加权分。
3. 验证脚本首期由维护者注册，页面只选择；不开放任意脚本上传。
4. 旧案例保持原语义并标记文本判定，新案例使用 grading 才进入任务验收统计。
5. 审批规则按能力预检；SDK 缺失事件时先补设计，不绕过证据要求。

该确认已用于本次实现；B/C 尚未获开发授权。

## 14. 实施调查：SDK 事件能力边界（已确认）

源码 `sdk/packages/agents/src/agent-runtime.ts` 的 executePreparedTool 在检查 skipReason 前发出 tool-started，权限拒绝也会收到此事件。现有事件不能证明工具实际执行。

建议最小兼容扩展：在 prepareToolExecution 入口新增 tool-requested 事件（原始参数、toolCallId）；在现有 tool-started 事件中增加 executionStarted 布尔字段（仅有工具且无 skipReason 时为 true）。Core 适配层传递这些信息，现有事件和旧消费者行为不改变；评测器只根据明确的 executionStarted=true 记录实际执行。审批使用现有真实回调中的 toolCallId 关联，当前 yolo 不具备审批能力，预检仍拒绝审批案例。

2026-09-16 用户明确要求“暂不改 SDK，相关规则标记不支持”。本次不实施上述 SDK 扩展。独立行为检查器保留合成事件验收；当前运行适配器明确声明 requested/started/completed/approval 均不支持，必要行为规则在预检时报错，可选行为规则返回 insufficient。既有工具轨迹仍作为诊断展示，不伪装成真实执行证据。

## 15. 实现记录与验证结果

实现日期：2026-09-16。未修改 SDK，未启动 B/C 阶段。

- 新增 `src/grading/`：严格规则解析、文件/JSON 与独立进程验证、纯行为检查器、证据快照、超时/取消、状态聚合和分组统计。
- CLI/Web 共用 `runIsolated`；Agent worker 退出后再固定证据及判分。CLI 新模式默认空工作区，有 cwd 时复制 fixture；证据保存在案例集旁的 `.eval-data/runs` 或 EVAL_DATA_DIR 下。
- Web 提供结果/行为分组规则编辑、必要条件选择、注册验证器选择、参数 JSON 与整体 JSON 编辑；详情显示逐项预期/实际及证据，列表继续隐藏内部案例 ID/session_id。
- API、JSON/CSV/Markdown、多轮报告已接入；inconclusive 可筛选与重跑。旧案例保留文本判分，新模式按案例/规则版本统计任务通过率、成功比例与覆盖率。
- 可运行示例位于 `examples/grading/`，维护者注册说明见 README。

具体实现约定：文件字节保存为不可变证据 blob，通过 manifest 中的 baseline/artifacts 索引定位，不按建议示意目录重复保存两套同名文件；文件摘要与引用逐项可校验。manifest 同时保存运行时/平台和判分协议版本，case.json 保存本次案例与默认配置。验证器执行前后校验程序及声明依赖摘要；若有变化返回验证错误。

验证记录：

| 检查 | 结果 |
|---|---|
| `bun run typecheck` / `bun run build` | 通过 |
| `bun test` | 37 项通过；Windows 进程树专用测试按环境变量默认跳过，已单独运行通过 |
| `bun run smoke:web` | 通过，0 失败，覆盖原有批次/重复执行/取消/导出 |
| 新判分集成测试 | 真实本地 SDK + 模拟 HTTP 模型；Web、CLI、结果/证据接口、规则快照与取消留痕通过 |
| 编译后的 Node CLI | 指定 EVAL_NODE_BINARY 运行同一集成测试，通过 |
| Windows 进程树超时 | 在允许 taskkill 的测试环境通过，确认后代 PID 已退出；受限环境会记录清理错误，不会静默声称已完成清理 |
| 真实页面点击/视觉验证 | 当前 Computer Use 工具返回 No browser is available，未执行；前端 Bun 构建与 HTTP 入口已验证 |

测试环境实际安装 Bun 1.4.0、Node 24.17.0；仓库锁定工具链仍为 Bun 1.3.13，本次未更改工具链配置，尚未在该精确版本重复验证。

与验收场景的对应：A01–A08、A10–A17 覆盖于 grading 单元/集成测试及旧版回归测试；A09 仅合成事件检查器测试，真实审批按用户要求标记不支持；A18 通过 Windows 专项测试。规则编辑支持结构化选择和 JSON 参数编辑，未引入外部编辑器依赖。
