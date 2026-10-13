# SPEC-016：模型请求头逐请求 ID

- 状态：**Implemented / 已实施**
- 确认记录：2026-10-12 用户回复“实施”。
- 日期：2026-10-12（北京时间）
- 来源：用户要求每次向模型服务发请求都携带独立请求 ID，调查现有支持情况及修改方案。
- 范围：agent-eval；不修改 SDK，不改变 MongoDB 驱动版本。

## 1. 目标及现状

当前 headers.ts 仅允许 sessionId、caseId、evaluationId。runner.ts 在 ClineCore.start 前生成 evaluationId 并展开请求头；同一案例的多次模型请求和重试复用它。function-call.ts 也按一次案例执行展开。现有集成测试明确验证同一执行的两次请求使用同一 evaluationId。

新增 requestId，提供每次 HTTP 请求发送的 UUID。sessionId 继续关联整个会话，evaluationId 继续标识整个案例执行；requestId 不声称与 SDK 消息 ID 或响应 ID 相同。

## 2. 配置及用户操作

复用现有请求头编辑器，不增加固定头名或必填字段：

```json
{
  "headers": {
    "session_id": "{{sessionId}}",
    "request_id": "{{requestId}}"
  }
}
```

用户按模型服务要求填写头名，如 request_id 或 X-Request-ID。支持 requestId 嵌入非敏感字面字符串，同一请求中所有引用取同一值。headersEnv 沿用完整值读取，不新增环境变量模板展开。

## 3. 发送实现

SDK 已提供 ClineCore.create({ fetch }) 的本地模型传输入口，handler-factory 将其传给 gateway/provider。agent-eval 目前显式 backendMode: local，可通过该入口或已有的 providerConfig.fetch 会话级覆盖注入封装，不修改 SDK 或全局 fetch。

- 静态模板在案例开始时展开；requestId 引用转成该执行登记的唯一占位值和对应头的替换信息，保留到实际发送层。
- 发送封装读取最终有效 headers（同时覆盖 Request 与 init 输入），仅替换本执行登记的动态引用；不要扫描/替换任意环境变量或认证值。
- 每次 fetch 调用生成新的 UUID，同一调用所有引用复用该 UUID。每次重试也生成新 UUID；同一任务后续迭代及压缩等带所配置头的模型请求按同样规则生成。
- 正确保留请求体、流、取消信号、认证和其余请求参数，沿用底层 fetch；不自行重试，不改变代理或 CA 配置。
- SDK 执行通过注入的传输封装；单轮函数调用的直接 HTTP 发送通过同一 helper。Web worker 和 CLI 两条入口均覆盖。
- 动态引用按执行闭包管理并在 finally 停用，避免并发、重复执行及取消时串用；没有动态模板时保持既有行为。
- 发送失败、重试及响应消费保持原语义。运行快照保存未展开模板；本阶段不新增请求日志或结果关联字段，不承诺 SDK 内部日志包含最终请求 ID。

## 4. 兼容性与异常

无数据库合同变更、无需数据迁移或 mongo:prepare。已有三个变量、覆盖优先级、头名大小写和凭据环境引用不变；未知变量仍报错。requestId 不在案例开始时预生成最终值。所验证的 provider 必须在实际请求使用封装；不能只通过类型检查就宣称所有 provider 已覆盖。

## 5. 验收与实施步骤

1. 用户于 2026-10-12 回复“实施”，已确认此方案。
2. 扩展模板合同，新增请求发送 helper，接入本地 SDK 和单轮函数调用入口，更新 UI 提示及文档示例。
3. 本地 HTTP mock 验证三个评测模式、同会话多请求、重试生成新 ID、同请求多头复用 ID、并发隔离及原静态变量不变。
4. 单元测试覆盖 Request/init 头优先级、流体和取消信号保留、无动态配置不改头及执行后清理；运行类型检查、构建及现有请求头回归。
5. 记录实际测试 provider 和未覆盖环境，完成后标记 Implemented。


## 6. 实施与验证记录

2026-10-12 在 work 分支完成：

- headers.ts 支持 requestId，按合并后的字面头登记动态引用；原三个变量和环境变量来源保持不变。
- request-headers.ts 使用每次执行独立闭包，生成唯一占位值，仅在实际发送时替换对应头，单次发送所有引用共享新 UUID。Request/init 输入遵循 fetch 头优先级，保留原请求体、流、取消及其他参数；执行结束停用闭包。
- runner.ts 使用 SDK 已有 providerConfig.fetch 会话级覆盖接入，避免全局 fetch 或跨案例共享注册表；这与 SDK 默认 fetch 注入入口属于同一现有传输能力，实际使用更窄的会话范围，不修改 SDK。function-call.ts 使用同一 helper。
- 请求头编辑器展示 requestId 及重试语义；更新 README.md、STARTUP.md 和 examples/custom-headers.json。

验证合计 12 项通过、0 失败（分组运行）：

- 3 项新发送 helper 测试：逐请求 UUID、多引用一致、请求流及取消保留、Request/init 头覆盖、静态覆盖、原输入不改、环境认证值不展开、并发隔离及执行后停用。
- 3 项既有头合同单元测试及 2 项 Web 请求头测试；覆盖导入、修订、重复运行快照保留 requestId 模板。
- 1 项真实 SDK + 本地 HTTP mock 集成：并发完整任务和 429 自动重试逐请求不同 ID，三个评测模式和普通 CLI 均携带 UUID，旧 evaluationId 在同执行内保持不变，快照保留引用及凭据环境变量名。
- 3 项函数调用回归：原生单次请求、超时及大小限制、六工具验证器导入和历史试验证。
- TypeScript 类型检查、构建和 git diff --check 通过。

测试模型 provider 为 openai-compatible（本地模拟服务），未验证真实内网服务或全部其他 provider。首次 CLI 测试因默认会话目录不可写失败，已将测试 SDK 数据目录设置到临时目录并恢复环境，再次通过；没有修改产品存储行为。首次流测试因 Bun 二次构造 Request 后的流消费阻塞调整为检查真实转发的输入，保留流和取消语义验证。

数据库依赖仍为 6.21.0，没有降级；本功能不需要数据库迁移或 mongo:prepare。本阶段没有增加实际请求 ID 的结果日志关联字段。
