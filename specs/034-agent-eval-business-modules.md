# SPEC-034：评测平台正式应用与业务模块重组

状态：Implemented / 已实施并验证
日期：2026-11-09（北京时间）
基线：work / 2e5f54b；实施前重新核对分支与未提交改动。
用户已明确要求实施“先形成业务模块”和“前端迁移到组件框架”。本文落实第一项的具体设计；第二项见 SPEC-035。按应用 AGENTS.md，在具体方案确认前只编写方案。

## 1. 目标与范围

将 apps/examples/agent-eval 提升为 apps/agent-eval，由业务模块承载案例管理、运行编排、执行、规则验收、Judge 和证据归档。API、CLI、Worker 调用相同的应用服务；存储和 SDK 调用通过明确接口接入。

本期保留 Bun 1.3.13、Node >=22、现有 SDK、MongoDB 驱动和业务语义，不引入微服务、Redis、数据库替换、SSO、权限系统或新的沙箱。Worker 仍沿用当前独立子进程模型；不是本次建议的任务系统生产化改造。

本次不修改 SDK 源码、不新增脱敏规则，也不改变直接工作区、工具权限、任务重复和判分规则。

## 2. 调查依据与当前行为

已阅读根目录与应用 AGENTS.md、docs/agent-eval-intranet-roadmap.md、SPEC-001/015/025/026/033、根与应用 package.json、tsconfig、server/store/catalog/queue/runner、Worker、前端入口及 Web 冒烟脚本。roadmap 是历史设计背景，不视为其全部功能已获实施授权。

- 应用包 @cline/example-agent-eval 位于 examples，版本为 0.0.0。
- src/web/server.ts 同时组装服务、匹配路由、校验、调用目录和本地运行存储。
- EvalStore 将 SQLite 访问、业务规则、运行快照、投影和重启处理集中在同一类。
- CatalogRepository 已抽象 SQLite/MongoDB 目录能力；应复用这一边界。
- Web 任务从快照开始，在隔离子进程执行；CLI 在特定配置下复用隔离执行。
- MongoDB 只承担案例等目录数据，历史在 SQLite、证据在本地目录。默认 EVAL_DATA_DIR 目前与旧应用路径有关。
- src/web/client/app.ts 约 2,900 行，包含请求、路由、全局状态、页面与表单。

## 3. 目标目录与依赖

```text
apps/agent-eval/
  src/
    api/
      server.ts              # 依赖组装、生命周期和静态资源
      routes/                # 按业务拆分 HTTP 适配
      http/                  # 请求、响应、现有错误映射
    cli/                     # CLI 入口与参数适配
    modules/
      catalog/               # 模块/案例、版本、导入、复制和移动
      runs/                  # 批次、Attempt、排队、取消、重试和查询
      execution/             # 三种回放方式、工作区、SDK 适配
      grading/               # 规则、验证器、冻结输入和验收
      judging/               # Judge 配置、正式评分和试评分
      evidence/              # 会话、文件、轨迹和证据归档
      settings/              # 执行与 Judge 默认配置
    infrastructure/
      sqlite/                # 运行持久化、投影和兼容案例库
      mongodb/               # 目录与验证脚本仓储
      filesystem/            # 路径/文件读写的具体适配
    contracts/               # API DTO、Worker 消息和共享纯类型
    worker/                  # 子进程启动入口
  web/                       # 由 SPEC-035 迁移
  scripts/
  docs/
  examples/
  tests/
```

依赖规则：API/CLI/Worker -> 应用服务 -> 业务规则和端口；基础设施实现端口，由应用入口注入。业务规则不依赖 HTTP Response、DOM 或具体数据库。前端只使用公开合同和可在浏览器运行的纯函数，不导入 store、队列、数据库或 SDK 执行模块。

共享对象只在真正存在复用时提取，不为了每个类建立独立 workspace 包。本期使用原生 Bun HTTP 能力拆分路由，不额外叠加服务框架。

## 4. 业务拆分的完成要求

不能仅移动文件后保留原大类职责：

1. CatalogService 管理案例/模块用例，复用现有 CatalogRepository 与 revision/writeVersion 协议；HTTP 路由不复制相同规则。
2. RunService 管理快照创建、重复轮次、Attempt、取消和重试；RunQueries 负责摘要、详情和报告读取；RunRepository 负责事务及持久化。
3. EvalStore 逐步拆为 SQLite 仓储、投影和兼容适配，避免业务服务访问 db/query/records 表实现细节。
4. ExecutionService 统一模式选择与结果装配，Cline SDK 依赖收敛到适配器；工作区租约及现有阶段事件继续保留。
5. Grading/Judging/Evidence 保持独立职责，沿用当前冻结输入及验收语义，不把 Judge 答案注入被测执行。
6. 通过可注入的执行器、仓储和时钟/ID 来源支持既有测试；不为重构引入大量无业务价值接口。

## 5. 合同、目录迁移和兼容

- 正式包名 @cline/agent-eval。根 workspace 已匹配 apps/*，更新 lockfile、构建、脚本和文档引用。
- 旧 examples/agent-eval 保留必要的命令兼容壳和迁移 README，旧包名脚本转发到新应用；不保留第二套业务实现。
- 盘点旧路径的 Web/CLI/构建/离线发布/Python 示例使用方式，提供对应转发或可验证的迁移说明；不得静默删除外部正在使用的导入入口。
- 兼容既有 API 方法、路径、状态码、JSON 字段、错误提示语义、下载文件和 hash 路由。DTO 与持久化模型分开，但本期不升级数据库合同版本。
- SQLite/MongoDB 集合、revision、稳定 UUID、事务、幂等身份、writeVersion、摘要投影及性能边界保持不变。
- EVAL_DATA_DIR 显式配置优先。目录移动不得意外创建空库掩盖原数据：保留既有仓库运行方式的旧默认目录解析，并提供明确的新启动说明；本期不自动移动历史数据。
- 检查并修复 import.meta.url、worker.ts/worker.js、fixture、验证脚本和资源相对路径。已归档运行的读取与重试要继续工作，必要时通过路径兼容适配解决，不批量重写证据内容。
- 现有 CLI/Web 公开命令语义继续可用，增加新的正式应用运行命令。

## 6. 异常与生命周期

复用当前参数错误、权限/连接错误、版本冲突和执行中断的分类。重启仍按现有策略标记中断，不增加自动重跑副作用。服务关闭需停止调度、取消活动任务、等待现有清理并关闭资源；不能因拆分产生多个队列或数据库连接所有者。

## 7. 实施步骤

1. 记录现有应用 typecheck、测试和 Web smoke 基线；区分预存失败和本次回归。
2. 建立正式应用、入口与路径兼容，迁移测试并更新脚本；先保持行为。
3. 按 catalog -> runs/settings -> execution -> grading/judging/evidence 拆分职责，每批迁移验证相应业务链。
4. 抽出前后端公开合同，与 SPEC-035 对接；修复浏览器 bundle 对服务端模块的隐式依赖。
5. 验证旧命令、旧数据库/历史、发布包和 Python 示例路径，更新 README/STARTUP/roadmap 链接。
6. 与 SPEC-035 完成全链路回归后记录结果与偏差；最终产品不依赖旧大文件实现。

## 8. 验收标准

- API 层只做协议适配和调用应用服务，主要业务行为能脱离 HTTP 验证。
- 三种回放模式、复制/直接工作区、并发/重复/取消/重试、Judge、脚本和证据行为回归通过。
- 已有 SQLite 历史可直接读取；MongoDB 目录数据及 Java/Python 外部写入合同不变。真实 Mongo 测试只使用隔离库；缺条件则明确记录未验证，不宣称通过。
- SPEC-026 的轻量摘要、详情懒加载、变化游标、稳定选择和大案例集响应行为不退化。
- typecheck、build、相关测试、Web smoke 和发布 smoke 通过；预存问题单独记录。
- CLI 和 Web 都能从新位置启动，旧公开命令兼容路径经过实际验证。
- 本期不更改 UI 外观；相关浏览器回归在 SPEC-035 记录。无用户指令不提交/推送本批重构。

## 9. 确认与验证记录

本方案已于 2026-11-10 获得确认并实施。发现 API/数据语义或迁移范围必须实质变化时先更新方案并确认；已批准范围内的文件命名和拆分顺序自主处理。

确认记录：2026-11-10（北京时间），用户回复“继续实施”，批准本文具体范围。


### 2026-11-10 实施结果

- 正式 workspace 为 `apps/agent-eval` / `@cline/agent-eval`。API、CLI、Worker 分开；业务按 catalog、runs、execution、grading、judging、evidence、settings 组织，共享合同集中到 contracts。
- CatalogService/LocalCatalogService、RunCommands/RunService/RunViews、SettingsService 承载业务行为；仓储和运行读写端口隔开数据库细节。SQL、投影、MongoDB 目录/验证器仓储和 CLI 脚本库读取集中在 infrastructure。EvalStore 保留兼容门面，委托业务服务。
- SDK 会话创建集中在 execution/runtime；不修改 SDK、数据库合同及冻结快照/Attempt/幂等语义。归档与旧工作区产物查找进入 evidence 服务，报告和 CSV 生成进入 runs。
- 旧目录只保留命令转发与 Python 入口/JSON 样例兼容文件。实际验证旧 CLI help/typecheck、Web 启动和 Python Bad case 文档构造。根目录新增 agent-eval、agent-eval:web、check:agent-eval、test:agent-eval。
- 核实旧源码服务的实际默认数据目录为 `apps/examples/.eval-data`，仓库启动继续使用该目录；独立发布包使用包内 `.eval-data`。EVAL_DATA_DIR 优先，不自动移动历史数据。
- 新架构、启动、构建、发布和迁移说明见 `apps/agent-eval/docs/architecture.md`；更新当前 roadmap 与 Python 示例文档，保留历史 spec 的背景记录。

| 验证 | 结果 |
|---|---|
| 迁移前完整基线 | 144 pass / 15 skip / 2 fail，共 161 项 |
| 迁移后完整测试 | 145 pass / 15 skip / 2 fail，共 162 项，225.69 秒 |
| 报告/重试/摘要专项 | 9 pass / 0 fail |
| 资源读取/投影/路径专项 | 15 pass / 0 fail |
| 前后端类型检查、生产构建 | 通过 |
| 新服务和 React lint（48 文件） | 通过，无 error |
| Web smoke | PASS，0 failure，覆盖执行、取消与历史查询 |
| 独立发布 SDK smoke | passed=true，真实 SDK 请求本机模拟服务 1 次，输出 Use Bun |
| 旧 Web/独立发布 Web | HTML、哈希资源与 API 均 200，HTML no-store、资源 immutable |
| 冻结锁文件安装 | 通过，无依赖变更 |
| 函数 schema / 12 个生成脚本校验 | 通过 |
| Vite 开发代理 | 正常同源写入 201，外站 Origin 写入 403 |
| git diff --check | 通过 |

两项失败与基线相同，均在 `modules/catalog/importable-examples.test.ts`：`portable example suites import with the current Web model settings`、`portable example suites contain every user-facing case exactly once`。本次不改变已有示例集内容来掩盖预存失败。

真实 MongoDB 副本集及 Windows 专属进程树条件未提供，对应 15 项按既有条件跳过；不宣称这些环境已验收。SQLite 使用隔离临时目录，未连接内网库或调用收费模型。业务端口保持必要的兼容适配，没有引入额外服务、数据库迁移或权限系统。本批重构完成时未自动提交；后续提交推送按用户明确指令执行。
