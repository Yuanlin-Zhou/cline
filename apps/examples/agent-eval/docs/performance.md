# 大案例集与批次性能

对应根目录 SPEC-026。案例正文、历史输入、全部执行尝试及归档证据继续保留；页面通过摘要、按需详情和变更游标访问数据。

## 更新和迁移

1. 停止旧 Web 服务，确认没有其他进程使用同一数据目录，然后更新程序。
2. 使用原数据目录启动。首次启动会在 SQLite 中构建案例摘要、执行摘要、进度及批次版本表；同一目录的运行实例会加锁，离线重建也会检查实例锁。控制台输出迁移前一致性备份的位置 `eval.pre-performance-时间-随机后缀.sqlite`。
3. 迁移完成后才开放服务。首次迁移可能耗时，且需要备份和索引的额外磁盘空间；日常启动不会重建全部大 JSON。

SQLite 的 WAL 数据由数据库备份操作处理，不要只复制正在运行的 `eval.sqlite` 文件作为备份。迁移中断时保留原始记录及备份，修复报错后重新启动；不会跳过异常行将其当成成功。不要同时启动多个迁移实例。

新版本更新原记录与摘要时使用同一事务，进度单独持久化。**迁移后不要用旧程序直接写同一数据目录**。需要回退时先停止新程序，将整个当前目录另行保留，再用迁移前的 SQLite 备份恢复 `eval.sqlite`；确保没有遗留当前版本的 `eval.sqlite-wal`/`eval.sqlite-shm`（只能在所有连接关闭后处理）。保留原运行归档目录，再启动旧程序。回退会丢失备份创建后的数据库修改，恢复前需明确选择所需数据时间点。

外部直接修改 SQLite JSON 会绕过摘要维护；使用应用 API 修改。若需要校验后重建摘要，先停止 Web，然后执行：

```sh
bun scripts/performance-storage.ts /绝对路径/评测数据目录 --rebuild
```

重建也会先备份、保留原始输入/结果及已持久化进度，并更换游标世代。重建失败不删除原始记录；重新启动后浏览器需要重新同步概览。

MongoDB 模式仍使用 MongoDB 保存案例/模块/上传脚本、本地 SQLite 保存运行历史。本次新增 MongoDB 字段投影查询，没有新增集合、修改文档校验器或新增 MongoDB 索引要求；现有部署应已满足此前 `mongo:prepare` 合同。不要为这次性能优化将 MongoDB 案例迁回 SQLite。

## 查询接口

- `GET /api/cases?view=summary[&moduleId=...]`：`{cases, latest}`，不包含输入正文、Judge 参考答案或完整 defaults。
- `GET /api/modules?view=summary`：`{modules, counts}`；`GET /api/cases/tags` 获取标签候选。
- `GET /api/cases/:id`：完整案例，编辑/复制时按需获取。
- `GET /api/runs/:id/overview`：批次、统计、cursor 和各根执行的最新摘要。摘要带 `summary:true`，不是可直接用于执行的输入。
- `GET /api/runs/:id/changes?cursor=...`：本批次变化的最新摘要。客户端按 rootItemId（旧记录回退 id）替换；无变化仅返回 cursor 和空 items。`resync:true` 时重新获取 overview；服务重启或索引重建会更换游标世代。
- `GET /api/runs/:id/items/:itemId`：所选执行完整详情；`.../attempts` 返回其尝试摘要；`.../progress?version=...` 获取所选项变化的有限实时文本及状态。
- `GET /api/runs/:id/retry-preview`：只读候选摘要。提交仍使用原 `/retry` 的 requestId、expectedRetryRevision 和范围参数；服务器事务内重新核验。
- `GET /api/runs/:id/report?attemptMode=latest`（或 first）：按需报告。输出一致性根据已保存正文的规范化哈希比较，展开输出再读完整执行；报告不能证明工具真实执行。

运行时采用顺序轮询；终态更新与原始输出、费用、Judge 分数仍可通过详情复核。列表摘要不包含最终输出，不能把其中空的 text 当成模型实际返回空文本。

取消操作可使用 `POST /api/runs/:id/cancel?view=summary` 返回轻量概览，省略参数保持原完整响应。

旧 `/api/state`、完整批次 GET 及 JSON/CSV/Markdown 导出保留原结构。正常页面不再用完整接口轮询；旧外部客户端仍可能产生大响应。导出保留全部尝试、原始快照及结果，统计继续区分最新状态与全部尝试成本。

## 可复现验证

接口与数据库基准完全使用临时数据目录、本地模拟记录，不调用模型、不使用已有服务的数据。覆盖 prompt、普通历史与原生函数调用历史，200 个 10–200 KiB 案例，额外 0/5/25 批历史。默认每项预热一次并测量 30 次，保存环境、体积、P50/P95：

```sh
bun scripts/benchmark-web.ts --samples=30 --output=/绝对路径/performance-results.json
```

浏览器脚本只读取显式指定的测试服务；服务需预置含未通过项的已结束批次。它打开重试确认框但不确认启动，不调用模型。依赖可用的 Playwright 和 Chromium，路径可显式提供：

```sh
bun scripts/benchmark-browser.ts --url=http://127.0.0.1:3134 --samples=30 \
  --playwright=/路径/playwright/index.mjs --chromium=/路径/chromium \
  --output=/绝对路径/browser-performance-results.json
```

浏览器测量在同一已加载应用内热导航，分别使用正常 CPU 与 4 倍限速；记录长任务和浏览器版本。首次 JS 加载、首次迁移和模型耗时单列。性能测试尽量独立运行，避免其他全量测试或编译与其争用 CPU。

正确性检查：`bun run typecheck`、`bun test src/web/performance.test.ts`、相关重试/统计/复制/可观测性回归及 `bun run smoke:web`。真实 MongoDB 测试需配置专用 `EVAL_TEST_MONGODB_URI` 副本集；不配置时跳过，投影模拟测试不能替代真实集群验证。

本次量化结果与验证边界见 [SPEC-026 实测记录](performance-026-results.md)。
