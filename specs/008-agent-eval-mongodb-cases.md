# Agent Eval MongoDB 案例存储与展示编辑

状态：Implemented
批准记录：2026-10-09 用户回复“继续实施”，批准完整方案，包括模块元数据迁移。
日期：2026-10-09
需求确认：2026-10-09 用户确认“按新结构设计”，并选择“两类案例统一存入 MongoDB，保留混合批量操作”。随后已批准完整实施方案，包括模块元数据迁移。

## 1. 目标与已确认需求

外部系统在 MongoDB 中生成单轮回放案例，agent-eval 直接读取并展示，同时保留新建、编辑、标签、复制、移动、删除、导入和回放能力。MongoDB 是案例内容的权威存储，不将 MongoDB 简化成一次性导入源或只读展示数据。

用户先选择“读取外部已有的 MongoDB 案例，应用负责展示和回放”，随后明确补充：评测系统仍保留单轮查看编辑，整体存储改到 MongoDB。本方案不修改 SDK、请求头安全处理或判分语义。

## 2. 当前链路与关键决策

目前 EvalStore 使用同步 SQLite records 表保存 settings/module/case/run/item；/api/state 一次读取全部有效案例，详情从 state 获取内容。保存、导入、复制/移动及运行提交均直接调用 Store。RunItem 持有完整案例快照，执行工作进程不实时读取案例。

建议将两种回放模式的**案例**统一迁移到 MongoDB 的 agent_eval_cases 集合，单轮通过 definition.replayMode 区分；设置、批次、执行结果和已有历史继续在 SQLite。模块元数据也迁移到同一 MongoDB 数据库的 agent_eval_modules 集合，使模块归档、批量案例归档与案例移动可以统一校验和事务提交。原因：案例可以切换回放模式，列表可混选两种模式，统一集合可以使用 MongoDB 事务保留批量复制/移动/导入的原子性。

用户已确认两种案例统一迁移。模块元数据迁移是本完整方案中额外明确的配套范围：若模块仍在 SQLite，归档模块与 MongoDB 案例变更不能构成同一事务。本方案不引入跨数据库的分布式提交。

## 3. 推荐 MongoDB 文档结构

MongoDB 使用 collection（集合）。建议集合名 agent_eval_cases；数据库名默认为 agent_eval，集合名默认为 agent_eval_cases / agent_eval_modules，可通过服务端配置指定。保留现有内部 UUID，避免破坏详情链接及历史关联。

```javascript
{
  _id: "案例内部 UUID",                  // 对应 SavedCase.id，不使用业务案例名作为主键
  schemaVersion: 1,
  moduleId: "现有模块 UUID",
  revision: 1,
  archived: false,
  createdAt: ISODate("2026-10-09T00:00:00Z"),
  updatedAt: ISODate("2026-10-09T00:00:00Z"),
  definition: {
    id: "history-bun-install",            // 模块内业务案例 ID
    replayMode: "single-turn",
    description: "验证模型遵循历史上下文",
    tags: ["回归", "上下文"],
    history: [
      { role: "user", content: "项目使用 Bun，请用中文回答。" },
      { role: "assistant", content: "好的。" }
    ],
    prompt: "安装项目依赖应该执行什么命令？",
    assertions: { contains: ["bun install"], finishReason: "completed" },
    headers: { "x-session-id": "{{sessionId}}" },
    headersEnv: { Authorization: "EVAL_AUTHORIZATION" }
    // 兼容已有 EvalCase 可选字段，如 systemPrompt、timeoutMs、grading 等
  },
  defaults: {
    providerId: "openai-compatible",
    modelId: "your-model",
    apiKeyEnv: "EVAL_API_KEY",
    baseUrl: "https://gateway.example/v1",
    timeoutMs: 180000,
    maxIterations: 10,
    tools: "read-only"
    // 完整保留 EvalDefaults 的可选字段与两层请求头配置
  },
  provenance: {                          // 可选；应用保存时原样保留
    source: "external-generator",
    sourceId: "外部案例标识"
  }
}
```

- 单轮 history 是原始上下文，prompt 是本轮问题；保留顺序和原文，不存入实时模型结果。单轮继续固定 tools=none、maxIterations=1。
- 模块 ID 必须对应同一 MongoDB 数据库中的有效模块。外部生成端可通过现有模块 API 获取 ID；接入外部生成器时必须校验归属，不能仅凭模块名称自动匹配。
- 字符串 UUID / revision / 数据内容保持现有 SavedCase 语义。BSON 日期在 API 边界转换为 ISO 字符串；_id 映射为 id，额外元数据不泄漏或丢失。
- 配置只保存环境变量名称，不保存凭据值；前端不会收到 MongoDB URI。
- 外部写入者需遵守同一文档合同；更新时同时匹配 _id + revision、递增 revision 并更新时间，避免覆盖评测系统的编辑。未经版本递增的外部覆盖无法由应用乐观锁保证安全，应在接入合同中明确。
- 对现有不同字段结构，先根据真实脱敏示例确定适配/迁移方式；不得猜测字段映射或启动时自动改写未知外部文档。

### 索引与验证

```javascript
db.agent_eval_cases.createIndex(
  { moduleId: 1, "definition.id": 1 },
  { unique: true, partialFilterExpression: { archived: false }, name: "active_module_case_unique" }
);
db.agent_eval_cases.createIndex(
  { moduleId: 1, archived: 1, "definition.replayMode": 1, updatedAt: -1 },
  { name: "module_mode_updated" }
);
db.agent_eval_cases.createIndex(
  { archived: 1, "definition.replayMode": 1, "definition.tags": 1 },
  { name: "mode_tags" }
);
```

_id 自带唯一索引。JSON Schema validator 要求 schemaVersion=1、revision 为正整数、archived 为 bool、moduleId 为字符串、时间为 BSON date、definition/defaults 为对象；单轮 definition 要求 id、replayMode、prompt 和 history，history 每项为 user/assistant 与字符串 content，tags 为字符串数组。更完整的工具、规则、请求头语义仍由 parseEvalSuite 校验，MongoDB validator 不能代替应用校验。

所有新建/迁移文档显式保存 archived=false，避免字段缺省绕过局部唯一索引。索引/validator 通过独立准备脚本安装，不要求正常运行凭据拥有数据库管理权限。

### 模块集合 agent_eval_modules

```javascript
{
  _id: "模块 UUID",
  name: "read_file",
  nameKey: "read_file",                  // name.trim().toLowerCase()，保持现有名称唯一语义
  description: "文件读取、路径处理与边界行为",
  tags: ["文件操作"],
  archived: false,
  createdAt: ISODate("2026-10-09T00:00:00Z"),
  writeVersion: 1                        // 事务并发协调使用，不向用户展示
}
```

对 nameKey 建立 archived=false 的局部唯一索引。新库初始化可沿用当前四个默认模块，但只有显式初始化脚本可以创建；常规读取不在已有外部库中自动写入默认模块。

模块操作与案例写入在同一数据库事务内完成。案例修改/导入/转移时，对涉及的源/目标模块校验有效性并更新 writeVersion，形成写冲突检测，避免“仅在事务中读模块”留下并发归档竞态。模块归档在一笔 MongoDB 事务中标记模块及其当前有效案例为归档；模块恢复继续保留现有行为，仅恢复模块，不隐式恢复案例。重命名/标签修改和模块有效性均由 MongoDB 返回，不维护 SQLite 镜像。

## 4. 存储与代码接入

- 新增异步 CatalogRepository 接口（模块 CRUD/归档、案例 list/get/create/update/delete/import/previewTransfer/transfer 等），SQLite 和 MongoDB 分别实现。Web 服务在 MongoDB 模式不再直接读写 records(kind=case/module)。SQLite 实现继续服务原模式及回归测试。
- MongoDB 使用官方驱动，Bun 管理依赖；连接池在服务启动时创建，服务退出时关闭。MongoDB 事务依赖 replica set / sharded deployment，本地验收使用单节点副本集。
- 服务端配置：EVAL_CASE_STORAGE=sqlite|mongodb、EVAL_MONGODB_URI、EVAL_MONGODB_DATABASE、EVAL_MONGODB_CASE_COLLECTION、EVAL_MONGODB_MODULE_COLLECTION。MongoDB 模式显式启用且连接/集合合同校验通过才提供案例功能；连接失败不静默切回 SQLite。SQLite 模式保留已有部署和测试兼容性。
- /api/state、案例详情与历史定位、保存、导入预览/提交、旧 duplicate、标签候选和运行创建改为 await repository。补充 GET /api/cases/:id，详情直接取得对应 MongoDB 文档；请求错误显示重试，不能显示旧缓存为已保存内容。
- 前端继续使用 SavedCase，标签与复制/移动交互不重做；保存带 revision，未保存草稿不被异步结果覆盖。
- 列表和标签候选每次读取来自 MongoDB，无 SQLite 内容副本或静默导入缓存。首期保留现有列表筛选行为，不顺带引入分页产品改造。
- 模块新建/编辑/归档/恢复接入 repository，按上文模块集合协议事务执行。启用 MongoDB 时 SQLite 仅保留 settings/run/item 为权威数据；已有 case/module 记录保留备份但不作为运行时来源。

## 5. 写入、复制移动与运行规则

- 保存使用原子条件更新 _id+revision，成功 revision+1；冲突 409，保留前端草稿。外部元数据通过精确字段更新保留。
- 同模块业务 ID 冲突由唯一索引兜底；duplicate key 转换为可理解的 409。
- MongoDB 事务中重新读取全部源版本及目标名称，复用已批准 rename/abort、copyN/moveN、unchanged 规则；整批失败回滚，历史记录不跟随更新。
- transaction callback 不触发外部模型、不写 SQLite 历史，自动事务重试不额外创建最终副本或批次；UUID/结果确认规则需覆盖提交结果未知的情况。
- 单轮/多轮模式切换在同一集合更新，不复制为另一个身份。
- 运行提交先读取并校验完整 MongoDB 案例，固定快照后一次写入 SQLite run/item。MongoDB 读取失败时不创建部分批次；后续编辑不改变已提交快照。
- 历史重跑/导出仅使用已存在的 SQLite 快照；即使原 Mongo 案例被删或暂不可访问，历史执行数据仍可查看；案例历史路由通过 snapshot.id 定位执行，无需先 require 当前 Mongo 案例，有快照则返回历史，完全未知 ID 返回 404。未保存草稿运行继续使用浏览器提交的草稿。

## 6. 已有数据与迁移

- 默认不迁移/覆盖外部集合，不启动自动迁移。
- 提供显式迁移脚本，支持 dry-run、逐项验证、ID 冲突报告和可重跑检查；保留模块/案例内部 id、案例 revision、配置、标签、归档状态，补齐日期/replayMode/archived。
- 在停写窗口完成校验与切换；迁移复制 module/case 记录，先校验/迁移模块再迁移案例；不删除 SQLite 原始记录，不改 run/item。模块和案例关联或业务名冲突时输出报告。已有 Mongo 文档冲突时报告并停止，禁止默认覆盖。
- 若外部文档示例与推荐合同不同，迁移工具/适配规则需先补充到 spec；原有历史 snapshot.id 的关联以保留 UUID 为准。

## 7. 验收与实施门槛

完整方案（包含模块元数据迁移）于 2026-10-09 获得批准，已按以下标准实施和验证。

1. 外部写入的有效单轮案例无需导入即可在列表/详情展示，编辑后直接更新 MongoDB；新建、标签、导入、删除与复制移动保存正确。
2. 单轮模型调用、历史上下文、请求头与断言保持当前行为，原有历史与模式切换完整兼容。
3. 真实副本集测试唯一索引、版本并发、批量回滚、事务提交结果未知与连接失败；候选读取错误不清空草稿。
4. MongoDB 不可用时案例 API 返回明确错误，历史列表/详情/导出/历史重跑仍可使用 SQLite（新增独立 GET /api/runs，解除历史页面对 /api/state 的案例读取依赖），不回退到过期 SQLite 案例。
5. SQLite 回归、Mongo 集成测试、浏览器展示编辑、TypeScript typecheck、Web bundle、迁移 dry-run 与 diff 检查通过；不使用真实模型凭据验收。
6. 更新部署说明、初始化脚本、示例文档和本 spec，完成后标记 Implemented。


## 8. 实施步骤与运维配置

1. 用户确认完整方案，记录确认并改为 Approved。
2. 添加官方 MongoDB 驱动与 CatalogRepository，先建立副本集集成测试；规范文档映射、乐观锁、模块协调和错误码。
3. 提供集合 validator/索引准备脚本、JSON 示例与 SQLite 迁移 dry-run/执行工具；数据库账户权限分开说明。
4. 服务端 API 和运行快照生成改为异步 repository，详情与历史接口解除对全量案例读取的依赖。
5. 验证模块归档、混合批量复制/移动、模式切换、标签、新建/编辑、外部创建、迁移及故障恢复。
6. 浏览器和回归验收，更新 README/部署说明并记录真实测试结果。

部署示例（占位 URI，真实凭据只通过服务端环境注入）：

```sh
EVAL_CASE_STORAGE=mongodb
EVAL_MONGODB_URI=mongodb://127.0.0.1:27017/?replicaSet=rs0
EVAL_MONGODB_DATABASE=agent_eval
EVAL_MONGODB_CASE_COLLECTION=agent_eval_cases
EVAL_MONGODB_MODULE_COLLECTION=agent_eval_modules
```

连接池设置明确的 serverSelectionTimeoutMS/connectTimeoutMS 和连接数上限。部署预检查需确认可用事务能力与索引，不将单机 standalone 的批量操作伪装成事务。临时连接失败返回 503、文档非法返回可理解错误、缺少记录 404、版本/业务名冲突 409；Mongo URI 不出现在 API 响应或错误日志。迁移和集合初始化由用户显式运行，正常服务不会自动覆盖外部数据。


## 9. 实施与验证记录

2026-10-09 完成实施。

- 新增 CatalogRepository 与 SQLite/MongoDB 实现。MongoDB 集合为 agent_eval_cases / agent_eval_modules，包含 BSON 日期、版本、模式、配置、元数据保留、可执行 validator 及唯一/筛选索引。
- MongoDB 事务复用 transfer 规划算法；涉及案例变更的模块 writeVersion 用于归档竞态协调。复制 UUID 在事务回调外生成，提交重试不会再创建副本。案例归档递增 revision，使旧编辑窗口失效；模块恢复不会隐式恢复案例。
- API 通过异步 repository 读写；新增案例/模块单条 GET、模块列表、独立历史列表和设置 GET。运行创建固定 MongoDB 读取快照后写入 SQLite，不实时绑定 Mongo 文档。历史、导出及历史重跑不依赖当前案例存在。
- 详情从单条 API 获取对应文档；列表/详情失败可点击重试，过期的异步页面响应不会覆盖新页面。保存冲突保留表单草稿；标签、复制移动与窄屏布局已保留。历史与运行配置页面不依赖案例全量读取。
- MongoDB 模式不会自动初始化模块、创建索引或迁移数据；提供 mongo:prepare、mongo:migrate（默认 dry-run）和可重跑显式迁移。SQLite 模式仍是默认部署方式，不做连接失败回退。
- 集合合同、部署步骤、外部写入者协调协议和迁移说明见 apps/examples/agent-eval/docs/mongodb.md；Extended JSON 示例位于同目录 mongodb-case.example.json。文档放在 docs 而非可导入案例集 examples，避免被当作 CLI suite。

验证：

1. 本地 MongoDB 8.0 单节点副本集，官方驱动 6.21.0 / BSON 6 与 Bun 1.3.13 实测。驱动 7.7.0 / BSON 7 调用了 Bun 未实现的 V8 snapshot API，故固定使用兼容版本；未修改 SDK。
2. 全量 agent-eval 测试启用 EVAL_TEST_MONGODB_URI 后：66 通过、1 跳过（已有 Windows 专用进程树测试）、0 失败。最后针对存储/API/历史再验证 23 项通过；最终 Mongo 集成 7 项通过。
3. 真实 Mongo 集成覆盖外部插入实时展示、版本并发仅一方成功、模式切换、元数据保留、混合模式名称冲突、过期预览、事务第二次插入失败回滚、提交连接中断重试仅一份副本、模块归档与转移竞态、恢复行为、唯一索引/validator、非法外部文档、索引缺失预检查及 URI 错误无凭据回显。
4. HTTP 验证编辑写回 MongoDB、不写 SQLite case、运行快照不变、删除后历史可读；关闭 Mongo 连接后案例返回 503，而历史列表/导出/案例历史与快照重跑仍可用，失败读取不会创建部分 run。
5. Chromium 实测外部文档列表/详情、新增标签写回、保存冲突保留草稿、复制、混合单轮/多轮移动、历史页、请求失败重试及延迟详情响应不覆盖历史页；1440px/375px 无整体横向溢出，无浏览器运行错误。
6. 迁移命令实际 dry-run → apply → 再次 apply：先报告 4 模块/1 案例、提交后重跑全部 skipped；源 SQLite 只读，未更改 queued 历史。集成测试验证冲突停止和同一事务提交。
7. 额外真实 standalone MongoDB 启动检查：明确拒绝不支持事务的部署。
8. TypeScript typecheck、Web bundle（服务启动与 HTTP 测试构建）、git diff --check 通过；相关历史测试显式选择 SQLite，不受部署环境变量污染。锁文件只新增本功能依赖，未变更其他工作区版本。

部署范围：仅在临时本地数据库验证，没有连接用户正式 MongoDB，也没有自动迁移生产数据。投入使用需按部署说明配置 URI/副本集及准备集合；旧 SQLite 案例须显式迁移。
