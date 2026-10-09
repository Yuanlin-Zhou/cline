# Agent Eval 请求头：SDK Hook 日志脱敏补充

状态：Rejected / 用户明确不实施  
日期：2026-10-08  
关联：`specs/001-agent-eval-custom-request-headers.md`（已批准，实现中）

确认记录：2026-10-08 用户明确回复“不要改 SDK，不用脱敏”。本方案保留为调查记录，不实施；按用户最新要求修订 spec 001。

## 1. 目标与范围

批准一个必要的 SDK 扩展，防止模型网关回显授权值时，SDK 在评测报告脱敏前把秘密写入 Hook 审计日志。仅修改 SDK Hook 日志序列化及其初始化参数，保留原 Hook 行为、判分证据和错误语义，不关闭日志，不更改模型请求或全局 fetch。

## 2. 当前行为与复现

已实现评测侧 headers / headersEnv 配置、合并与传递，真实 HTTP 测试证明 Authorization 可覆盖 OpenAI-compatible 默认 API key 认证。

本地网关返回 HTTP 401，其错误消息包含假 Authorization 值。评测报告/worker 消息已脱敏，但逐文件扫描发现 `failed/session/logs/hooks.jsonl` 包含假授权值。原因是 `sdk/packages/core/src/hooks/hook-file-hooks.ts` 的 createHookAuditHooks 直接 JSON.stringify 错误 payload，并在评测器收到结果前落盘。CLINE_LOG_ENABLED=0 不关闭该审计日志。

这不是配置头值直接落盘，而是错误回显经 SDK 审计日志落盘。原 spec 第 5 节和第 9 节要求发现此情况后修订范围并确认，因此本补充先以 Draft 提交。

## 3. 设计与接口

- 给 SDK Hook 运行配置增加可选的日志脱敏值列表或等价内部序列化回调；该参数仅作用于写盘，不修改 Hook 输入对象、执行结果、控制返回值或模型消息。
- local-runtime-bootstrap 从当前会话显式传入的 apiKey、headers、providerConfig 中的相应值提取日志脱敏值，传给内置审计 Hook 和文件 Hook 的日志写入路径。
- 序列化之前按字符串字段进行替换；Authorization 的完整值及 Bearer/Basic 后的凭据部分均可脱敏，忽略空值。替换标记使用 `[REDACTED]`。
- 普通请求头只需保护被识别的凭据头与 API key，保留 session/case 标识和其他诊断信息。头名匹配大小写不敏感。
- 不将脱敏值列表写入日志；不打印、回传或保存实际环境变量值。
- 与当前评测侧脱敏结合，保证先落盘的 SDK 日志和后输出的报告均受保护。

## 4. 兼容性与异常处理

- SDK 调用方式保持向后兼容；未提供显式秘密值时日志格式和执行行为不变。
- 不将模型 401 改成成功，不隐藏失败状态，也不移除 Hook 记录。
- 不声明这是通用 DLP：任意编码、网关变形回显、未知 OAuth 秘密和用户自行写出的秘密不在本次范围内。
- 若实际检查显示还有其他 SDK 落盘路径，则先报告、补充范围，不能用事后删除日志冒充安全写入。

## 5. 验收标准

1. SDK Hook 单测验证 error message/stack、tool-result 错误中的已知假凭据被脱敏，原对象保持不变，正常 Hook 记录保留。
2. 文件 Hook 与内置审计日志都覆盖，验证无配置秘密时行为兼容。
3. 重新构建 SDK，重跑 agent-eval 的真实 HTTP 集成测试：并发、多次模型调用、Authorization 覆盖、错误回显和 SDK 保存目录扫描全部通过。
4. agent-eval 全量测试、typecheck、相关 SDK 测试和 git diff --check 通过，记录准确计数与平台跳过项。

## 6. 实施步骤

1. 用户确认 SDK 脱敏扩展范围，记录日期并改为 Approved。
2. 检查 Hook 文件日志与审计路径，添加失败单测。
3. 实现可选序列化脱敏参数和 bootstrap 传递，不改变业务行为。
4. 构建 SDK，验证相关 SDK 测试和评测系统集成。
5. 更新两个 spec 的实施结果，达到验收后改为 Implemented。

## 7. 当前验证

真实请求携带自定义头的正常执行测试通过；HTTP 401 回显测试在 SDK 日志扫描处失败。SDK 未修改；用户明确拒绝，本方案不实施。
