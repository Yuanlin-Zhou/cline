# Agent Eval 自定义模型请求头

状态：Implemented  
日期：2026-10-08  
适用范围：`apps/examples/agent-eval`  
确认记录：用户于 2026-10-08 回复“没问题，继续”，批准本 spec 范围的实现与验证。随后明确回复“不要改 SDK，不用脱敏”，取消新增脱敏和 SDK 日志扫描的验收要求；SDK 及既有日志/错误输出行为保持原样。

## 1. 目标与范围

让 CLI、JSON/JSONL 导入和 Web 评测均能为模型请求设置自定义 HTTP 请求头，包括 `x-message-id`、`x-session-id`、`Authorization`。支持全局默认值、案例覆盖和服务端环境变量引用。沿用现有 SDK 接口，首期不修改 SDK。

本次 spec 按用户要求新建在仓库根目录 `specs/`。既有 agent-eval/specs 文档保留。本次变更属于一个完整功能，实现、测试和文档共享本 spec；之后独立行为变更新建 spec。

不包括任意请求体参数、URL query、代理配置、模型采样参数、自定义 JavaScript fetch，以及逐次模型 HTTP 请求自动生成 message ID。若后续需要这些能力，应另建 spec。

## 2. 当前行为与调查依据

- 已阅读 `docs/agent-eval-intranet-roadmap.md` 和既有 agent-eval spec。Roadmap 已列出内网自定义 HTTP Headers 未接入的问题；其他建议不视为本次批准范围。
- `src/types.ts` 的 EvalDefaults 仅暴露 providerId、modelId、apiKeyEnv、baseUrl 等连接设置，EvalCase 无请求头设置。
- `src/schema.ts` 构造规范化配置时丢弃未知字段，直接在 JSON 加 headers 不会生效。
- `src/runner.ts` 的 runCase 创建 sessionId 并调用 ClineCore.start，仅传入 apiKey、baseUrl，没有传 headers。
- Web 通过 `appendConfigFields` / `readConfig` 编辑模型设置；Store 保存 defaults 和案例快照；worker 重新 parseEvalSuite，任何新增字段必须贯穿这条链路。
- SDK 已有 `ClineConfig.headers: Record<string,string>`；core runtime-builder、handler-factory 将其传给 provider config；OpenAI / OpenAI-compatible / Anthropic 等 provider 已支持 headers。
- Provider 对请求头与自动认证的最终合并行为需以实际 HTTP 测试验证，不能只断言 Runner 参数。首期重点验收 OpenAI-compatible 内网端点。

## 3. 配置接口

EvalDefaults 和 EvalCase 都新增两个可选字段：

```ts
headers?: Record<string, string>;
headersEnv?: Record<string, string>;
```

headers 保存非敏感字面值；headersEnv 的 value 是环境变量名称，在运行进程中读取其完整值。Authorization 以及常见密钥头必须使用 headersEnv，不允许把密钥字面值写入导入文件、数据库快照或表单。

```json
{
  "version": 1,
  "defaults": {
    "providerId": "openai-compatible",
    "modelId": "company-model",
    "baseUrl": "https://gateway.example.com/v1",
    "headers": {
      "x-session-id": "{{sessionId}}",
      "x-message-id": "{{evaluationId}}"
    },
    "headersEnv": { "Authorization": "EVAL_AUTHORIZATION" }
  },
  "cases": [{
    "id": "example",
    "prompt": "你好",
    "headers": { "x-business-tag": "regression" }
  }]
}
```

EVAL_AUTHORIZATION 在启动评测服务/CLI 前设置为完整头值（例如含 Bearer 前缀的值）；系统不自动添加或猜测前缀。无需另加 CLI header 参数，CLI 使用 suite 文件即可。

## 4. 合并、模板与生命周期

1. 请求头名称按 HTTP 规则忽略大小写；同一层出现大小写不同的重复名称时报错，不按 JSON 顺序决定结果。
2. defaults.headers 和 defaults.headersEnv 组成默认层；case.headers 和 case.headersEnv 组成案例层。
3. 同一层同名头不得同时配置字面值和环境引用。案例层同名条目完整替换默认层条目，包括取值方式。
4. 案例层不影响同名以外的默认头；首期不支持删除某个继承头，空对象仅表示无新增覆盖。
5. 合并完成后才解析环境引用，已被覆盖的默认引用不要求存在。环境变量在 worker/CLI 中读取，不从浏览器读取。
6. headers 字面值支持三个严格模板：`{{sessionId}}` 为结果中实际 SDK sessionId，`{{caseId}}` 为案例 ID，`{{evaluationId}}` 为每次案例执行新生成的 UUID。未知模板报错。不对环境变量值做模板替换。
7. 每次执行生成独立 sessionId/evaluationId，包括重复评测和重新运行；一个 full-task 的多次模型调用复用本次执行的头值。
8. `x-message-id: {{evaluationId}}` 标识一次评测执行，不声称它是每次模型调用/重试的唯一 ID。若网关要求每个 HTTP 请求独立 ID，需要另一项 SDK 请求级扩展，不能用本方案伪装实现。
9. 在 runCase 调用 ClineCore.start 前解析并传入 `config.headers`。未配置时不传，保持原默认认证行为。
10. 显式 Authorization 应覆盖 OpenAI-compatible 自动认证头，大小写不敏感；通过本地 HTTP 服务捕获真实请求验证。其他 provider 沿用 SDK 行为，不承诺覆盖 OAuth 刷新或其专有认证头。若必需的目标行为无法通过现有 SDK 实现，应回报并更新 spec 确认，不能静默扩大 SDK 改动范围。

## 5. Web 与持久化

- 模型设置表单增加“自定义请求头”编辑区：名称、来源（固定值/环境变量）、值/变量名，可增删行；提示内置模板含义。
- 设置页、案例编辑和批次模型设置复用组件；案例定义可覆盖默认头。保留既有模型设置和批次 useSettings 语义，不改变配置来源优先级。
- 导入、导出、SQLite 保存、案例修订与运行快照完整保留 headers/headersEnv 和未展开的模板。
- worker 输入文件、数据库配置快照只保存配置和环境变量名称，不把解析后的环境值加到配置中。
- 不新增“有效请求头值”展示，不将授权值回传前端。
- 结果沿用既有 sessionId 字段；列表仍不展示 sessionId，详情保持现有展示偏好。
- 运行时 headers 进入 SDK 内存配置。调查发现网关错误回显会进入 SDK hooks.jsonl；已向用户提出补充 spec 002，用户明确拒绝 SDK 修改，并要求不新增脱敏。按最新指令沿用 SDK 日志行为，不承诺错误回显值不会落盘。

## 6. 校验与异常处理

- 两个字段必须是普通对象，值必须是字符串；headersEnv 的变量名符合 `[A-Za-z_][A-Za-z0-9_]*`，禁止空引用。
- Header 名称符合 HTTP token 语法；头值不得包含 CR、LF、NUL 或不被 Headers 接受的字符。固定头值允许空字符串；环境凭据不得为空。
- 禁止配置 Host、Content-Length、Connection、Transfer-Encoding、Content-Type 等由 SDK/HTTP 层管理的传输与编码头，不限制合法业务自定义头。
- 拒绝 Authorization、Proxy-Authorization、x-api-key、api-key 等常见凭据头的字面值，错误指引改用 headersEnv。其他业务敏感值也建议引用环境变量。
- 模板替换后的值再次校验，避免案例 ID 引入非法头字符。
- 配置结构问题在导入/保存时返回具体字段路径；缺失环境变量在案例开始模型请求前失败，错误仅包含头名/变量名，不包含解析值。
- 按用户最新指令不新增错误/报告/诊断日志脱敏，保留现有输出及失败状态语义。
- 并发执行使用独立不可变头对象，不修改 process.env、suite.defaults 或其他案例配置。

## 7. 兼容性

- suite version 继续为 1，两个新字段均可选；旧配置、数据库记录和发布包配置无需迁移。
- 现有 apiKeyEnv 不变；Authorization 引用与 apiKeyEnv 可同时存在。API key 是否仍为特定 provider 的初始化要求沿用 SDK，不用虚构 key 绕过验证。
- 新 Web 保存逻辑保留新增字段，worker 重解析不丢失；单轮/完整任务、并发、取消、重复评测与重跑不改变语义。
- 不扩展 grader/verifier 网络请求；自定义头只交给模型 provider。

## 8. 验收标准

1. 旧 schema、Runner、Web 导入/存储测试保持通过。
2. 新 schema 测试覆盖合法头、非法名称/值、模板、凭据字面值、重复名称、同层来源冲突。
3. Runner 测试覆盖默认+案例覆盖、跨来源覆盖、缺失变量、模板、重复执行 UUID 和并发隔离；验证不修改输入对象。
4. 本地 OpenAI-compatible HTTP 服务捕获真实请求，收到期望的 x-message-id、x-session-id 和 Authorization，后者能覆盖 SDK 默认认证值；仅用假凭据，无需真实模型或外部网络。
5. full-task 本地模型至少响应两次，验证两次调用复用本次 session/evaluation 标识，另一个案例执行使用不同标识。
6. Web 设置→保存→案例/批次快照→worker 配置→Runner 的链路不丢字段；导入导出可往返。
7. 数据库配置快照和 worker 输入 suite 文件保留环境变量名称，未加入解析后的授权值。验证 HTTP 401 仍按原有模型失败行为返回；不要求报告/SDK 日志脱敏。
8. agent-eval 的相关单元/集成测试、typecheck、必要 SDK rebuild 和 git diff --check 通过；若环境阻止 HTTP 监听，诊断并在有权限的本地测试环境完成，不以 mock 参数替代实际请求验收。

## 9. 实施步骤

1. 用户确认本 spec 的字段、头值语义及首期范围；记录确认日期，改为 Approved。
2. 检查 SDK 配置持久化、认证覆盖和错误输出；用本地 HTTP 测试确认既有能力。已按用户最新指令取消 SDK 日志脱敏扩展。
3. 添加 schema/解析器失败测试，实现类型、结构校验、大小写归一化、合并、模板和环境变量解析。
4. Runner 接入 config.headers，补并发、重复执行、异常语义与真实 HTTP 测试。
5. Web 共用配置编辑区、案例覆盖、导入导出与批次快照接入，补链路回归测试。
6. 更新 README 和不含密钥的导入示例，解释服务端环境变量及 message/session 标识边界。
7. 执行验收，记录测试结果、限制和偏差，改为 Implemented。

## 10. 实施记录

- 已增加默认与案例级 headers/headersEnv 的类型、schema 校验、大小写归一化、合并、模板和运行期环境解析。
- Runner 复用 SDK config.headers，未修改 SDK。Web 设置页、批次配置和案例编辑共用请求头编辑组件，独立案例覆盖区保留案例定义的优先级。
- 新增 README、导入字段说明和 examples/custom-headers.json，不包含真实凭据。
- 本地真实 HTTP 测试验证 Authorization 覆盖默认 API key 头、并发隔离、完整任务两次请求共享标识，以及 401 保持失败语义。
- SDK 日志泄漏回归最初复现后，用户明确要求“不要改 SDK，不用脱敏”。因此取消新增脱敏代码和该扫描验收要求，保留配置文件只存环境引用的验证；补充 spec 002 状态为 Rejected。
- 最终 `bun test`：50 通过、0 失败、1 个 Windows 进程树专项测试按平台条件跳过，共 51 项；12 个测试文件。真实 worker/HTTP 集成在本地运行，无外部模型凭据。
- `bun -F @cline/example-agent-eval typecheck`：通过。
- Web 浏览器 bundle 构建：通过（9 个模块）。
- `git diff --check`：通过。新增 TypeScript 文件使用仓库 Biome 格式化。
- SDK 源码、依赖声明与 lockfile 均未修改；使用环境中已构建的 SDK dist。日志和错误回显沿用 SDK 行为，补充 spec 002 不实施。

