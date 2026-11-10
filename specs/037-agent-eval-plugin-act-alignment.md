# SPEC-037：完整任务评测对齐插件 Act 运行配置

状态：Implemented / 已实施并验证
日期：2026-11-10（北京时间）

确认记录：用户于 2026-11-10 明确接受 SDK Act 通用工具范围并要求开始实施。

## 1. 目标与范围

用户选择仅对齐五项：系统提示词、工具集合与权限、Act 执行模式且无人审批、上下文压缩、配置快照与执行记录。完整任务尽量与当前 VS Code SDK 路径一致，不模拟 VS Code 独有功能。

本期不加入 MCP 服务配置、插件 Hooks/远程配置桥接、人工追问应答、VS Code 终端/编辑器适配器、依赖准备机制或其他模型采样参数。保留工作区机制、超时、迭代上限、独立 Worker、自动验收。单轮文字和函数调用模式保持现有执行行为。优先复用已公开接口，不修改 SDK 实现源码。

## 2. 当前行为与依据

已阅读应用与根 AGENTS.md、docs/agent-eval-intranet-roadmap.md、SPEC-015/034/035，及以下源码：

- 评测：contracts/evaluation.ts、contracts/replay.ts、modules/execution/runner.ts/runtime.ts、modules/grading/run.ts、modules/runs/queue.ts。
- 插件：sdk/cline-session-factory.ts、sdk-session-config-builder.ts、vscode-session-host.ts。
- SDK：shared/src/prompt/cline.ts、core/src/types/config.ts、core/src/runtime/orchestration/runtime-builder.ts、agents/src/agent-runtime.ts。

当前 full-task 使用案例/默认 systemPrompt，否则为两句评测专用提示词。工具 full 时 mode=yolo，其他为 act；开放工具 autoApprove=true，但进入审批能力回调时直接拒绝。工具默认 read-only；完整任务默认 maxIterations=10、timeoutMs=300000。评测未显式配置 compaction。

插件使用共享 buildClineSystemPrompt，传入工作区元信息、平台、Provider 和 Act/Plan 模式；自动压缩默认开启，策略来自 SDK 全局设置读取函数。插件和评测都关闭子 Agent、Agent Teams；不作为本次差异项。插件常规 MCP settings 同样关闭，但另有 McpHub 注入，不能据此声称评测已对齐 MCP。

## 3. 实施方案

### 3.1 提示词

- full-task 默认使用共享 buildClineSystemPrompt，mode=act，传入真实工作区路径/名称、平台、Provider，以及可通过公开 SDK 接口取得的工作区元信息。
- 主机身份使用真实的评测终端宿主（Terminal Shell），不声称存在 VS Code UI。复用产品任务规则，避免手工复制提示词正文导致漂移。
- 保留已有自定义 systemPrompt：案例显式值优先于默认配置，作为完整替换，不静默拼接额外评测指令。记录提示词来源（shared-act/custom/legacy）及构建参数。
- 不再默认加入“禁止询问用户”的评测专用句子；interactive=false 保持不变，不在本期模拟用户回答。需要交互输入的任务作为已知能力边界记录。

### 3.2 工具集合与权限

- 使用 SDK Act 工具预设及当前模型的工具路由，不另行复制一份固定工具实现。
- full：开放 Act 预设中可用的通用工具；read-only：继续限定 read_files/search_codebase；none：继续禁用工具。明确禁止用“自动批准”绕过 enabled=false。
- 新建完整任务默认建议 full，以便执行编辑/命令类任务；已有显式 read-only/none 原样保留。切换回放模式不能直接覆盖已有选择；需要区分新建默认和既有值。
- 保留 enableSpawnAgent=false、enableAgentTeams=false、disableMcpSettingsTools=true。不将 VS Code 的额外 MCP、UI 工具计入已对齐工具。
- 记录请求策略与实际注册工具清单，区分“未注册/宿主不支持”和“被案例策略禁用”。只记录 SDK 实际可观测的数据，不用推算清单冒充实际清单。若公开接口不足，实施前在方案中注明具体能力缺口。

### 3.3 Act，无审批等待

- full-task 始终 config.mode=act，不再因 full 权限切为 yolo；不设置 yolo=true。
- 允许工具的 autoApprove=true；禁止工具 enabled=false。审批能力回调对已允许且需回调的请求直接返回允许，不出现人工审批等待；对禁止/不在本次开放集合的请求仍拒绝。
- 保留 SDK 的参数校验、工具前置检查、失败处理、工具路由和执行限制；“不审批”不等于禁用这些机制。
- 不通过自动回答 askQuestion 或自动切 Plan 来模拟用户。迭代上限与总超时继续由评测控制。

### 3.4 上下文压缩

- full-task 默认显式开启 SDK 自动压缩，与插件的默认开关一致。
- 使用同一公开策略读取逻辑（readCompactionStrategyGlobally）确定默认 basic/agentic 策略；评测配置可明确覆盖 enabled 与 strategy。启动 Worker 前解析并冻结本次策略，避免隔离目录改变读取来源。
- 直接使用 SDK 压缩实现及其模型信息和预算机制，不自行按字符截断历史，不新增一套压缩提示词。
- 记录有效开关、策略、是否触发及公开事件中的压缩起止/结果/失败信息。沿用 SDK 既有压缩失败行为，不吞错、不无限重试。
- 可支持同一配置在单轮案例中存储，但仅 full-task 启用本次新行为。

### 3.5 配置快照与执行记录

区分提交快照与运行时记录：

1. 提交时冻结案例、默认配置、解析出的 full-task profile 版本、工具范围、Act/自动批准策略及压缩设置。
2. Worker 启动后记录实际 cwd、Provider/模型、最终提示词及其哈希/来源、实际可观测工具清单、SDK/应用版本与执行限制。
3. 执行中保存模型迭代/工具事件及压缩事件；完成、失败、取消均保留已生成记录，并标明尚未完成解析的字段。
4. 结果详情提供只读“生效执行配置”折叠区；大提示词和长列表按需加载，复用现有证据下载机制，避免混入列表摘要。

不序列化函数、密钥值、完整 process.env。凭据继续使用环境变量名/现有凭据引用，沿用现有敏感信息处理机制；本期不另建脱敏系统。请求头动态模板与既有 requestId/sessionId 规则不变。

## 4. 接口与数据变更

拟在 EvalDefaults/EvalCase 增加可选 fullTaskRuntime 配置；具体名称在实现时统一到 schema/API/Python 导入文档：

```ts
fullTaskRuntime?: {
  promptPreset?: "plugin-act" | "legacy-eval";
  compaction?: { enabled?: boolean; strategy?: "basic" | "agentic" };
}
```

- 案例字段优先于 defaults；对嵌套可选项按字段合并，显式 false 不可丢失。
- tools、systemPrompt、maxIterations、timeoutMs 继续使用既有字段，不重复建等价字段。
- 新提交的 full-task 默认采用 plugin-act profile，生成版本化的 resolved runtime snapshot。允许显式 legacy-eval 供旧基线对照。
- 配置快照记录新增字段使用可选、带版本格式；旧数据仍可读取。运行记录以独立证据保存，详情 API 按需提供。
- CLI full-task 与 Web 复用相同配置解析；CLI 冻结策略的时机在初始化隔离 Worker 前。

## 5. 兼容性与异常

- 既有自定义 systemPrompt、显式工具限制、工作区方式、模型连接、超时和迭代限制保留。
- 旧的已提交/已完成批次不能因为升级而改变配置。历史重试/重新运行应沿用其历史 profile；无新字段的历史快照按旧规则解释。新建批次才使用新默认，结果中明确区分。
- 缺失 profile 的普通案例配置可继续加载；新建批次时解析新默认并固定。未知 profile/压缩策略在提交前报错。
- 共享提示词构建失败应报出真实原因，不静默回退为旧提示词并宣称已对齐。
- 工具缺失或被禁用如实记录；不引入 VS Code 专用工具替代品，不自动提升案例权限。
- 配置落盘失败不能当作完整可追溯运行成功；取消/超时保留部分记录。
- SDK 的运行时插件/文件加载仍可能带来环境差异；本方案不保证 MCP、Hooks、交互体验与插件等价。

## 6. UI 与验收

保持 SPEC-036 恢复后的布局，不重新设计页面。完整任务配置中增加紧凑的“运行行为”分组，包含提示词预设、自动压缩开关/策略，以及 Act/自动批准只读说明；保留原工具范围选择。结果中增加只读折叠配置记录。

验收：

- 同一工作区/Provider 下，共享提示词使用同一生成器与 Act 参数；自定义替换优先级正确。
- full + Act 可执行编辑和命令，无人工审批等待；read-only/none 不越权。SDK 工具参数校验仍有效。
- 压缩开关与 basic/agentic 透传正确；利用公开机制/可控数据验证触发事件和结果记录，而非仅断言设置了 enabled。
- 新批次快照冻结后修改默认配置不影响正在运行批次；旧批次重试仍使用历史行为。
- 成功/错误/取消/超时均能读到相应生效配置和已产生的事件；没有密钥或整个环境变量转储。
- 单轮文字、函数调用、原有工作区/自动验收/LLM Judge 流程回归。
- 类型检查、相关运行与配置测试、生产构建通过；前端在桌面和窄屏实际操作并查看截图，检查长提示词、空/错误/重试状态和配置折叠展示。

## 7. 实施步骤

1. 用户确认具体方案后标记 Approved。
2. 实现共用 full-task 配置解析、版本化快照与兼容策略。
3. 接入共享提示词、Act 工具策略和 SDK 压缩；补充 Worker 记录。
4. 完成配置表单/结果详情与合同文档同步。
5. 测试与浏览器复核，记录偏差后标记 Implemented。

实现及验证已完成，记录见下节。


## 8. 实施与验证记录

- 新 full-task 提交使用 plugin-act-v1。使用 @cline/shared 的共享提示词生成器和 @cline/core 的工作区元信息、压缩策略读取接口；SDK 源码未修改。复用 Act 工具预设；已开放工具自动批准。自定义提示词完整替换，显式只读/禁用权限保留。
- 新建案例切换到完整任务且尚未指定工具范围时默认 full；已有案例不自动扩权。
- EvalCase/EvalDefaults 增加 fullTaskRuntime。提交时在最终 defaults 合并后冻结 preset 和压缩策略；旧排队项及无新字段的历史重跑使用 legacy-eval，旧 profile 保留旧模式作为基线对照。CLI 隔离执行前也冻结压缩策略。
- SDK beforeModel 钩子记录实际模型请求中的工具名和提示词，不以预设推算工具清单。记录提示词哈希、请求次数、SDK/应用版本、执行目录、限制与压缩通知；取消/错误时使用已收到的 Worker 记录。
- 完整运行结果包含 runtime，只在详情加载；列表摘要不包含该字段。复用现有 evidence 机制保存“生效执行配置 v1”和 SDK 诊断轨迹，沿用原有凭据处理，不记录 process.env 或密钥配置值。
- 配置页增加预设与自动压缩配置；结果详情→执行详情→任务配置快照→生效执行配置可查看记录。旧界面布局保留。

验证：

- 后端相关回归：65 passed，1 skipped（Windows 专用子进程测试）；覆盖合同、执行、重复批次、工作区及自动验收。
- 真实 SDK 配合本地模拟模型连续执行 read_files、search_codebase、editor、run_commands；断言读取/搜索输出、文件修改、命令输出和 Act 模式，全部通过。读取使用工具合同要求的绝对路径。
- 同一真实 SDK 流程验证 read-only 工具清单仅包含读取/搜索，none 清单为空；共享提示词、自定义覆盖和显式关闭压缩均验证。
- 超长初始历史实际触发 SDK Basic 压缩，收到并保存压缩事件；不是仅检查 enabled 参数。Agentic 使用同一 SDK 接口，验证配置透传，未独立构造 Agentic 评分质量基准。
- 新批次压缩参数冻结、修改案例不影响既有快照、无新字段历史重跑使用 legacy-eval 已测试。
- Chromium 浏览器回归：8 passed；覆盖新增配置保存/重载、完整任务运行及实际记录展开，同时回归案例管理、导入、历史、评测工作台和试评分。
- 已亲自查看桌面 1440×900 和窄屏 390×900 配置/结果截图：无整页横向溢出；长提示词和快照在局部滚动区域展示。修正了重复渲染压缩设置。
- typecheck、生产前端构建、修改范围错误级别 lint 通过。无真实外部模型调用。

截图：`specs/assets/037/act-config-1440.png`、`act-config-390.png`、`act-runtime-record.png`。

边界：不提供 VS Code 独有工具、MCP/插件 Hooks 或人工应答；不承诺两端请求逐字相同。共用提示词按真实 Terminal Shell 宿主与实际工作区生成。执行记录的工具清单是 beforeModel 观测到的模型可见清单，预请求失败时可为空，不能被当作已成功执行的证明。
