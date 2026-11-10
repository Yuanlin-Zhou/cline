# Agent Eval 架构与开发

正式应用：`apps/agent-eval`，workspace 包名：`@cline/agent-eval`。源码已按业务组织；Web 使用 React + TypeScript、Vite、TanStack Query、React Router hash 路由与必要的 Radix UI 原语。

## 入口和命令

使用 Bun 1.3.13；Vite 开发/构建所使用的 Node 建议为 22.12 或以上。以下命令在应用目录运行：

```bash
bun run typecheck
bun run build
bun run web
```

`web` 是本地便捷入口：资源缺失或前端/应用源码或 Vite 配置更新时先构建，然后启动 API 和工作台。生产使用预先构建的资源：

```bash
export EVAL_DATA_DIR=/absolute/path/to/history
bun run start:web
```

生产入口不会构建前端，缺少资源会明确报错。静态资源位于 `dist/web`，后端编译到 `dist`；发布包包含两者。API 的 `createEvalServer` 仍可由测试注入执行器并使用隔离数据。

CLI 保留 `bun run eval <suite.json>`，编译后入口是 `dist/cli/index.js`。从仓库根目录也可以运行：

```bash
bun run agent-eval:web
bun run agent-eval <suite.json>
bun run check:agent-eval
```

开发前端热更新时，在两个终端运行 API 和 Vite：

```bash
# 终端 1
bun run start:web
# 终端 2
bun run dev:web
```

Vite 默认端口 5173，将 `/api` 代理到 `http://127.0.0.1:3130`。可通过 `EVAL_API_ORIGIN` 指定后端本机地址。代理只转换开发页面自身的 Origin，跨站请求继续由后端拒绝；生产的本机访问限制未改变。

## 业务边界

```text
src/api/                         HTTP 适配、静态资源和依赖组装
src/cli/                         CLI 参数与报告输出
src/worker/                      每个执行的子进程入口
src/contracts/                   案例、执行、目录、投影和消息等共享合同
src/modules/catalog/             案例/模块、导入、复制/移动与资源规则
src/modules/runs/                创建、快照、Attempt、调度、查询与报告
src/modules/execution/           执行模式、SDK 适配、请求与工作区
src/modules/grading/             验证器定义、验收、冻结输入和试验证
src/modules/judging/             Judge 配置、评分和试评分
src/modules/evidence/            文件与会话证据
src/modules/settings/            全局执行与 Judge 默认配置
src/infrastructure/sqlite/       记录、摘要投影及兼容案例库
src/infrastructure/mongodb/      MongoDB 目录/验证器仓储和准备/迁移
src/infrastructure/filesystem/   服务锁、路径和旧目录兼容
```

- `CatalogService` 负责写入/导入/复制的输入和依赖校验，`CatalogRepository` 是目录端口，SQLite/MongoDB 是具体实现。
- `LocalCatalogService` 承载本地案例库操作；`RunCommands` 承载批次与重试规则；SQLite `EvalStore` 保留兼容调用方法并委托业务服务，实际 SQL 与投影仍封装在基础设施中。
- `RunService` 负责提交前选取快照、固定验证脚本并预检；`RunViews` 通过查询端口读取摘要和游标；`EvalQueue` 通过队列端口调度。
- SDK 会话创建集中在执行模块的 `runtime.ts`。父进程负责归档、验收和 Judge，Worker 只执行已准备好的输入。
- `RecordRepository`、运行读写端口和目录端口让业务服务不依赖具体数据库连接。CLI 脚本资源读取的数据库组装位于 `infrastructure/verifier-source.ts`；模块不包含 SQL。
- HTTP 路由按案例、运行、查询、证据、验证器、Judge、设置分开。新增业务规则应进入模块服务，路由只处理协议与结果映射。

## 前端组织与状态

```text
web/src/app/                     页面壳、路由和 providers
web/src/api/                     请求与错误处理
web/src/components/              表单、对话框、标签、请求头等组件
web/src/features/                案例、导入、执行、结果、脚本和 Judge
web/src/hooks/                   草稿、未保存保护和会话内试验证状态
web/src/styles/                  既有视觉规则及 React 适配
web/checks/                      实际浏览器验收
```

React 负责渲染和表单状态，不保留旧 DOM 应用。TanStack Query 管理服务端数据；输入草稿与查询缓存分开，后台刷新不会覆盖未保存修改。大文本和证据不会写入浏览器持久缓存。

案例列表读取摘要；案例与执行完整输入按需获取。运行进度使用 overview/changes 游标合并，选中项通过 progress 查询变化。任务终态或组件卸载停止对应轮询，保持大案例集已有优化。

所有会产生副作用的 mutation 都关闭自动重试，并在请求中禁用重复提交。JSON 编辑器错误在跨页签时保留并阻止保存。试验证任务身份保存在会话内缓存，关闭面板不会取消服务器任务。

共享合同与浏览器纯函数可复用；Vite 构建边界阻止将 Node/Bun、SDK 或模型运行模块导入浏览器。

## 旧目录和持久化兼容

旧 `apps/examples/agent-eval` 只保留 README、命令转发包和必要的 Python 入口兼容文件，不保留第二套业务实现。旧 Python 导入模块转发到正式应用，JSON 样例通过相对链接保留。

**实际旧默认数据目录是 `apps/examples/.eval-data`**：旧 server 从 `src/web` 向上解析三级目录。仓库内启动继续解析到该目录，避免目录重组后意外使用空库；单独发布包默认使用包内 `.eval-data`。`EVAL_DATA_DIR` 显式配置始终优先。迁移不会自动移动、清空或重写历史数据。

SQLite 运行历史、MongoDB 集合、修订号、模块 writeVersion、外部 Java/Python 导入合同和证据格式保持不变。工作区的 copy/direct 行为、工具策略、任务中断/重试与判分语义均沿用现有实现。

## 验证

```bash
bun run typecheck
bun run build
bun test
bun run smoke:web
CHROMIUM_EXECUTABLE=/usr/bin/chromium bun run test:browser
```

`test:browser` 启动临时数据目录和本机模拟模型，验证 React 交互与实际执行，不调用外网模型。可不指定 `CHROMIUM_EXECUTABLE`，改用 Playwright 已安装的 Chromium。测试工件默认写入忽略的 `test-results/browser`，失败会保存截图和 trace。

MongoDB 集成测试沿用 `EVAL_TEST_MONGODB_URI` 等既有开关，仅使用隔离测试数据库；未配置时跳过。Windows 专属进程测试需要在 Windows 环境执行。

正式 UI 验收还需亲自查看桌面与窄屏截图，检查短/长内容、空/错误/重试状态、弹窗和横向溢出。测试与实际复核记录见仓库根目录 SPEC-034/035。
