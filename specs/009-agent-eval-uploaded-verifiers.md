# SPEC-009：用户上传验证脚本并即时使用

- 状态：**Implemented / 已实施**
- 日期：2026-10-09
- 来源：用户要求取消管理员添加脚本后必须重启系统的限制，提供前端上传入口、执行结果字段说明和脚本示例。
- 关联：历史 SPEC-001、SPEC-003、SPEC-004，以及根目录 `specs/008-agent-eval-mongodb-cases.md`；`docs/agent-eval-intranet-roadmap.md` 的自定义验证脚本与正式验收脚本管理要求。
- 确认记录：2026-10-09 用户回复“继续实施”，批准本方案。
- 版本核查：2026-10-09，已拉取远端 `work` 并快进到 `3ab2521`（`feat(agent-eval): add MongoDB case and module storage`），以下方案以该提交源码为依据。

## 1. 目标与范围

用户在案例编辑页自行上传验证脚本，上传成功即可选用、保存案例并执行，无需管理员编辑配置或重启系统。脚本持久化，重启后继续可用。前端提供可下载的完整模板和字段说明。

首期上传支持单文件 `.js`、`.mjs`、`.ts`，使用当前 Bun 运行时执行，不要求用户填写服务端路径、shell 命令或安装运行时。Python、shell、依赖包和多文件上传不在本次范围；原有注册验证器继续支持既有可执行程序。沿用完整任务模式及既有判分语义，不修改 SDK、统计口径、行为证据能力或新增重新判分。

## 2. 当前行为与问题

- `src/web/server.ts` 启动时调用 `loadVerifiers()`，前端列表与案例预检使用该固定列表。
- `src/grading/run.ts` 每次执行独立读取 `EVAL_VERIFIERS_FILE`，没有用户上传脚本来源。
- `src/web/client/grading-editor.ts` 仅允许选择已注册程序，空列表要求联系维护者。
- 现有脚本输入为 `EVAL_CONTEXT` 指向的 JSON，输出为单个协议 JSON；前端未说明如何读取执行结果或产物。
- 原 SPEC-001 中“首期只支持预安装验证器，不在 Web 中上传可执行脚本”的限制由本方案替代。

### 2.1 存储版本核查与方案修正

已读取 `3ab2521` 的 `catalog.ts`、`mongo-catalog.ts`、`mongo-schema.ts`、`server.ts`、`store.ts`、`queue.ts`、`types.ts`、`docs/mongodb.md` 和根目录 SPEC-008，确认：

- MongoDB 仅迁移案例与模块，`CatalogRepository` 是其异步接口，`MongoCatalog` 管理连接、集合合同和事务；`SqliteCatalog` 仍支持旧部署。
- `EvalStore` 仍是 SQLite，负责 settings/run/item 和执行快照。`store.createRun(body, resolvedSources)` 仍同步，在 SQLite 事务内提交批次与所有执行项。
- Web 先从 catalog 解析案例，再交给 store；`parentRunId` 重跑从本地历史快照解析，不读取当前 MongoDB 案例。MongoDB 断连不得破坏此路径。
- `EVAL_CASE_STORAGE` 默认为 sqlite；mongodb 模式使用 MongoDB 驱动 6.21.0，读取服务端连接配置，集合/索引/validator 由 `mongo:prepare` 显式准备。
- 当前仍仅允许本机和同源访问，没有新增的账号或租户接口。本功能沿用现有边界，不凭空增加权限模型。

上一版的本地目录持久化设计修正为“脚本存储跟随案例后端，运行脚本随 SQLite 执行快照固定”；不把既有运行历史迁往 MongoDB，也不要求 SQLite 用户新增 MongoDB 配置。按最新 AGENTS.md 要求，本新方案放在仓库根目录 `specs/009-agent-eval-uploaded-verifiers.md`，保留既有历史 spec 原位。

## 3. 用户操作路径

入口：**案例详情 → 编辑 → 判定规则 → 启用任务结果验收 → 添加“使用验证脚本”规则 → 上传验证脚本**。

脚本规则卡片中提供脚本选择列表、上传区域、可选显示名称、“查看脚本格式与结果字段”和“下载示例脚本”。选择文件后显示文件名与大小，点击上传；成功后刷新列表并自动选中返回的脚本，原规则及其他未保存内容保留。上传仅保存脚本，实际执行发生在任务结束后的验证阶段；案例仍按原有保存按钮保存。

空列表提示“还没有验证脚本，可直接上传”，失败时显示具体原因并允许重试。列表明确区分用户上传与配置注册的程序。`command` 规则仍按退出码判定；`script` 规则按结构化输出判定。上传入口优先放在脚本规则内，不增加独立管理页。

## 4. 接口、存储与加载

### 4.1 上传与列表

- `POST /api/verifiers`，沿用现有 JSON 请求校验：`{ filename, content, label? }`。
- 服务端限制 UTF-8 脚本内容不超过 1 MiB，拒绝空内容、不支持的扩展名、非法字段和过长名称；客户端提前提示同样的限制。
- 服务端生成唯一 `uploaded-<uuid>` ID，通过新增 `VerifierRepository` 保存脚本；后端跟随 `EVAL_CASE_STORAGE`，MongoDB 模式使用同库集合，SQLite 模式使用现有 records 表的 verifier 类型。原始文件名仅作为展示元数据，不作为执行路径。
- 单个 MongoDB 文档同时保存脚本 UTF-8 内容、ID、显示名称、原始文件名、扩展名、内容 SHA-256、协议版本、创建时间等字段。1 MiB 限制下无需引入 GridFS；单文档原子插入避免源码与元数据分开写入的半成品，唯一 ID 索引防止覆盖。MongoDB 集合默认 `agent_eval_verifiers`，由服务端 `EVAL_MONGODB_VERIFIER_COLLECTION` 覆盖，禁止与案例/模块集合同名。`_id` 使用字符串 ID 并沿用其唯一索引，`createdAt` 使用 BSON Date；校验器约束 schemaVersion、扩展名、内容、摘要与版本。公开响应转换为 id 和 ISO 日期，不返回源码或服务端连接信息。
- 在 MongoDB 模式下，MongoDB 是上传脚本库的权威来源；不维护可供回退的本地脚本库镜像。SQLite 模式下脚本库使用现有 eval.sqlite。运行快照属于既有 SQLite 历史，保存该次使用的不可变脚本内容及版本；执行物化文件不是另一份脚本库。
- MongoDB 复用 `MongoCatalog.db` 及现有连接，由 catalog 统一关闭，不再引入独立长期连接；`createEvalServer` 增加可注入的验证器 repository 以保持测试和现有 catalog 注入能力。MongoDB 驱动保持 6.21.0。
- 更新 `mongo:prepare`，在部署本功能时一次性准备新增集合和 validator；应用启动仅检查合同、不创建集合或索引、不要求数据库管理权限。应用账号增加该集合的普通读写权限。该部署准备不涉及逐个脚本：后续用户上传无需管理员注册、改配置、准备集合或重启。
- `EVAL_DATA_DIR` 的运行目录继续保存产物及临时执行脚本。实际执行只使用已经持久化到当前 RunItem 的上传脚本快照，校验内容摘要后物化到 Agent fixture 外的独立验证目录，不重新从 MongoDB 取当前版本，不保存机器相关路径作为数据库执行配置。
- 返回 `201` 和公开验证器信息；`GET /api/verifiers` 返回配置注册与上传脚本的合并列表，并补充来源字段。
- 同名或重复内容上传生成独立 ID，不覆盖既有脚本；本次不增加替换或删除接口，避免影响已有案例和排队任务。

### 4.2 即时生效与执行一致性

新增 `VerifierRepository` 的异步 list/get/create 接口及 Mongo/SQLite 实现，独立于只管理案例/模块的 `CatalogRepository`。统一解析入口合并 `EVAL_VERIFIERS_FILE` 与当前上传脚本库。Web 列表和新运行预检使用同一解析逻辑；移除启动时固定列表及请求间共享可变列表，避免并发上传/运行造成列表竞态。

在 `/api/runs` 中按现有模式先解析 sources，并应用本次 replayMode 等覆盖后，异步获取这些案例实际引用的验证器，完成 preflight 后向同步 `store.createRun` 传递预检完成的输入及脚本快照。同步 store 内仅执行不依赖异步数据库的校验；不得通过临时改写全局 `store.validateCase` 传递请求列表。源码快照与批次/items 在现有 SQLite 事务中同时写入，失败不接受运行，不新增 MongoDB/SQLite 分布式事务。

为 RunItem 增加可选的 `verifierSnapshots`，每条上传脚本记录 `{id, label, filename, extension, version, sha256, content, timeoutMs}`；只固定该案例引用的脚本，重复轮次沿用同一版本。`makeExecutor` 将快照传给 `runIsolated`，由隔离运行物化后构造现有 Verifier 执行对象，沿用文件指纹与独立子进程协议。Agent worker 的 suite 不包含这些脚本源码。

`parentRunId` 重跑复用旧 items 的案例和脚本快照，MongoDB 断连仍能创建重跑与执行；历史详情、导出、取消流程不查询脚本库。老运行没有快照时，配置注册验证器继续沿用既有路径；若出现 uploaded ID 而快照缺失，明确报错，不能默默从库取新脚本。脚本记录不原位替换，同名再次上传生成新 ID。

新运行引用上传脚本时必须从当前库解析成功，数据库断连返回 503；配置注册脚本独立解析，不把无上传 ID 的旧 CLI 调用强制接入 MongoDB。CLI 仍保留 JSON 案例集方式；需要引用上传 ID 时，按服务端同名存储配置显式连接 MongoDB，或按实际 EVAL_DATA_DIR 读取 SQLite 脚本库，并在隔离执行前固定源码；连接仅在需要时创建并在执行结束后关闭。不得只共享目录就宣称 MongoDB CLI 可用，也不得无凭据回退到旧库。

仅将当前案例引用的验证器用于该次版本记录和 ruleHash，不因无关上传改变判分版本。数据库内容摘要不符、缺失文档或非法文档均阻止新运行并返回可定位错误。既有案例导入仍允许保存尚未解析的 verifierId，实际运行前完成可用性校验，不因本功能破坏注册验证器示例的导入流程。

旧配置文件也在后续请求/执行时重新读取，无需重启；ID 冲突、损坏配置或缺失脚本显式报错，不静默忽略或改用另一份脚本。历史案例仍使用 `verifierId`，schema 不变。

## 5. 前端脚本指南

### 5.1 输入

通过 `readFile(process.env.EVAL_CONTEXT, "utf8")` 并 `JSON.parse` 读取：

| 字段 | 含义 |
| --- | --- |
| `protocolVersion` | 当前为 1 |
| `workspace` | 执行结束后产物快照的独立副本路径；脚本以此读取交付文件 |
| `execution` | Agent 执行结果；不是最终判分结果 |
| `rule` | 当前规则的 ID、类型、必要性及验证器 ID 等配置 |
| `evidence` | 证据清单，含 `baseline`、`artifacts`、`refs`、完整性标志、能力及问题列表 |

### 5.2 execution 字段

| 字段 | 类型与说明 |
| --- | --- |
| `id`、`description?` | 案例 ID 与可选描述 |
| `sessionId` | 会话 ID，启动失败时可能为空 |
| `text` | 最终回复文字 |
| `finishReason?` | 结束原因，可缺省；不能仅凭 completed 认定业务通过 |
| `status` | 执行阶段沿用的旧状态，不能当作当前脚本或最终验收结论 |
| `execution.status` | completed / error / cancelled；优先用此判断执行情况 |
| `execution.reason?`、`error?` | 可选异常原因；任务预算超时可能为 task_timeout |
| `durationMs`、`iterations` | 执行耗时及迭代次数 |
| `usage` | inputTokens、outputTokens，及可选 cacheReadTokens、cacheWriteTokens、totalCost |
| `toolCalls` | name、input、output、durationMs、可选 error 的数组；仅供诊断，不能证明真实工具执行或审批合规 |
| `assertions` | 此时可能为空，不能用作最终验收结论 |

`execution.grading` 和 `execution.evidence` 是后续写入的最终报告字段，脚本执行时不要依赖；当前证据清单应读取顶层 `evidence`。可选字段要用默认值或先检查存在；敏感内容可能已脱敏，快照可能不完整。

### 5.3 可运行模板

提供两份单文件模板：读取 `execution.text` 与 `execution.execution.status` 验证最终回复；读取 `workspace/summary.json` 验证 `{total:12}` 产物。两个模板均使用 Node 标准库、无第三方依赖，可以直接上传运行。

模板以 `console.log(JSON.stringify({ protocolVersion: 1, verdict: passed ? "pass" : "fail", expected, actual, message, evidence: [] }))` 输出完整结果。证据数组只能填写顶层 `evidence.refs` 中已有 ID；诊断信息写 stderr。文件缺失、业务值不符合要求返回 fail；无法读取上下文或脚本自身异常返回验证错误。

脚本成功执行必须退出 0 且 stdout 只有一个合法 JSON 对象；退出 0 本身不表示业务通过。非零退出、格式错误、超时或输出超限归为验证错误。模板与字段说明在前端及 README/示例指南一致维护。

## 6. 兼容性、异常处理与执行边界

- 保留现有配置注册方式、`command` 规则和结构化协议，更新“需管理员注册/重启”相关文案与示例说明。
- 上传脚本库跟随 MongoDB/SQLite 案例后端，运行源码固定在 SQLite 执行快照，执行时物化的脚本位于 Agent fixture 外；验证继续在冻结证据的独立副本中执行，沿用超时、取消、进程树清理、日志限额、凭据白名单和脱敏。
- 上传不执行脚本，不通过运行用户代码判断上传有效性；语法或运行错误在验证阶段清晰展示。
- 保留本机访问及同源检查。界面说明上传脚本将在运行评测器的机器上执行，应只上传自己编写或信任的脚本；工作区副本不是 OS 沙箱。不引入新的管理员审批或重启步骤。
- 不因文件名中的路径片段允许越界写入；数据库元数据读取同样验证 ID、扩展名、内容摘要及字段。MongoDB 无法连接或持久化失败时返回清晰错误，不回退为未持久化的本地成功。
- 上传和列表沿用当前实际存在的本机访问、同源限制及服务端 MongoDB 凭据；不新增或假定账号/租户系统。数据库错误提示不得泄露 MongoDB URI 或凭据。
- 导入案例仍引用 verifierId；将案例导出到另一台机器时必须另行提供对应脚本，当前不把源码内嵌案例 JSON。

## 7. 验收标准

1. 未配置 EVAL_VERIFIERS_FILE 时，用户可在页面上传模板，立即自动选中、保存并执行脚本规则。
2. 用真实上传脚本验证正确/错误执行结果和产物，分别产生 pass/fail；异常、格式错误和超时产生验证错误。
3. 同一服务器进程上传后列表、预检、执行同时生效；服务重启或本地脚本缓存丢失后仍能从 MongoDB 加载并执行；使用相同数据库的另一服务实例也能读取上传脚本；既有配置文件变化也无需重启。
4. 两次同名上传及并发上传不会覆盖旧脚本；新上传不改变其他案例已引用脚本的版本与摘要。
5. 拒绝空内容、不支持的扩展名、超限及非法请求；跨站请求仍拒绝；文件名不能导致存储越界。数据库断连、写入失败、版本记录缺失及摘要不匹配均显式报错，同源/本机限制回归通过。
6. 前端显示输入/输出协议、真实结果字段、可选字段和错误语义，两份下载模板都可以通过实际协议校验。
7. 既有案例、CLI、command/script 判分及取消流程回归通过；相同 MongoDB 配置或 SQLite 数据目录的 CLI 能按所选后端加载上传脚本。
8. MongoDB 断连后，新运行引用上传脚本失败并显示 503；已接受的运行、历史详情、取消及含源码快照的重跑继续可用。MongoDB 和 SQLite 模式均验证，无自动降级或切换。

## 8. 实施步骤与验证计划

1. 基于已拉取的 `3ab2521`，确认方案后实现 VerifierRepository、Mongo/SQLite 实现及文档校验，扩展 mongo:prepare 和启动合同检查，补充输入校验和版本稳定性测试。
2. 接入列表、上传、异步 Web 预检、队列执行与 CLI 数据库来源，补充不重启的 HTTP/执行回归测试。
3. 增加前端上传、就近状态提示、字段指南和模板下载，更新相关示例与文档。
4. MongoDB 集成测试沿用 EVAL_TEST_MONGODB_URI 和独立测试副本集，未配置则明确跳过并记录限制，不连接生产库。运行针对性测试、`bun run typecheck`、`bun test`、`bun run smoke:web` 和 `git diff --check`；必要时通过浏览器检查上传及失败重试操作。无需模型凭据的测试覆盖完整验证脚本链路。
5. 记录实际验证结果与偏差，将方案状态改为 Implemented。

## 9. 实施与验证记录

- 2026-10-09 用户明确回复“继续实施”，按本方案实施；工作分支保持 `work`，基础提交为 `3ab2521`，未修改 SDK。
- 新增 `src/grading/uploaded-verifiers.ts`：上传合同、UTF-8/字节大小/文件名校验、内容摘要校验、MongoDB 与 SQLite repository，以及公开字段转换。MongoDB 脚本库复用现有连接和数据库，驱动仍为 6.21.0；新增集合通过 mongo:prepare 一次性准备。
- `GET/POST /api/verifiers` 支持实时列表与上传；服务端限制文件类型、1 MiB 内容和同源访问。上传不执行代码，同名上传生成独立 ID。
- `/api/runs` 异步预检并固定所引用脚本，源码快照与 SQLite 批次/items 原子写入；队列和隔离运行使用该快照，正式脚本不进入 Agent worker suite。重跑使用旧源码快照，断连不查询脚本库；CLI 按所选后端加载上传 ID，SQLite 读取只读连接，不中断排队历史。
- 前端增加文件选择、可选名称、上传进度/失败重试提示、成功后自动选中、完整结果字段表，以及最终回复/产物两种可下载模板。模板在前端、示例文件和指南中使用同一内容。
- 浏览器验证发现并修复：字段失焦校验改变布局，导致上传按钮指针点击落空；刷新含脚本规则的案例时，初始化未保存状态基线提前校验尚未加载的列表。现在卡片内转移焦点不触发布局变化，保存时仍完成校验；初始化基线使用原始 grading，正常保存/运行继续读取编辑内容。
- 新增 HTTP/实际脚本执行回归：上传即时选用、保存、两轮固定版本、重启后持久化、离线源码快照重跑、同名 ID 独立、路径/类型/大小/UTF-8 拒绝、真实 JS/TS/MJS 执行、业务 pass/fail、非法协议/脚本崩溃/超时区分，以及注册配置无需重启刷新。
- 在独立 Docker MongoDB 8.0 测试副本集完成 MongoDB 集成测试，包括持久化、关闭连接后的重跑及新运行 503，既有并发、事务、迁移、历史断连测试也通过。测试仅使用随机命名数据库，没有连接或修改生产数据库。
- 现有真实 SDK worker 集成测试补充上传脚本 → 执行结果 → 结构化判分的完整链路；确认 worker suite 不含上传验证器 ID 或脚本源码。模型请求使用本机 mock provider，无真实模型凭据。
- `bun test`：**73 通过，0 失败，1 跳过**，共 74 项；跳过项为 Windows 专项进程树测试，当前 Linux 环境不适用。
- `bun run typecheck`：通过；`bun run smoke:web`：通过，0 failure；`git diff --check`：通过。
- Chromium 浏览器检查通过：创建脚本规则、真实指针点击上传、自动选中、字段指南、模板下载、保存和页面刷新；无页面未处理异常。
- 环境验证记录：现有 VM 未在 PATH 提供 Bun，下载并使用项目指定 Bun 1.3.13；按最新 lockfile 安装 agent-eval 所需依赖，未改动锁文件或产品依赖。HTTP 测试在允许本机监听的执行权限下运行，初次沙箱 EADDRINUSE 不作为产品故障。独立测试容器验证后清理。
- 部署提示：MongoDB 用户升级此功能时，需运行一次 mongo:prepare 准备 agent_eval_verifiers 并给予应用集合普通读写权限；正常应用不要求数据库管理权限，此后每次用户上传不再需要管理员操作或重启。

实施范围无实质偏差。源码快照仍属于现有 SQLite 运行历史；不迁移历史、不引入第三方脚本依赖安装、不增加删除/替换脚本接口。
