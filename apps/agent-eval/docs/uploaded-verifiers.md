# 上传验证脚本（JS/TS 兼容协议）

在 **案例详情 → 判定规则 → 启用验收 → 使用验证脚本 → 上传验证脚本** 选择 UTF-8 .js/.mjs/.ts 文件，填写可选显示名称后上传。单文件上限 1 MiB，不安装第三方依赖。成功后自动选中，保存案例并以完整任务模式运行；无需管理员注册或重启。

脚本会在评测器所在机器执行，只上传自己编写或信任的脚本；独立工作区副本不是 OS 沙箱。上传时仅保存代码，不执行。

## 输入和输出协议

脚本通过 readFile(process.env.EVAL_CONTEXT, 'utf8') 读取 JSON。stdout 只能输出一个 JSON 对象，必须包含 protocolVersion: 1、verdict: 'pass' 或 'fail'、expected、actual、message（文字）、evidence（已有证据 ID 数组，可为空）。脚本退出 0 且格式合法才接受 verdict；退出 0 本身不表示通过。业务不符返回 fail；脚本异常、非零退出、非法输出、超时或超限属于验证错误。诊断写 stderr（console.error）。

输入 execution 是 Agent 执行结果，最终报告的 execution.grading、execution.evidence 尚未写入；请读取顶层 evidence。可选字段使用默认值。数据可能已脱敏，快照也可能不完整。默认脚本超时 60 秒，案例验证总超时 180 秒。上传只保存脚本，实际执行发生在任务结束后。

| 字段 | 含义 |
| --- | --- |
| `protocolVersion` | 输入协议版本，当前为 1。 |
| `workspace` | 运行结束后产物快照的独立副本；通过这个目录读取交付文件。 |
| `rule` | 当前规则的 id、kind、required 和 verifierId 等配置。 |
| `evidence` | 证据清单：baseline、artifacts、refs，以及 complete、eventsComplete、capabilities、issues。证据引用使用 refs 中已有的 id。 |
| `execution.id / description?` | 案例 ID、可选描述。 |
| `execution.sessionId` | 会话 ID；启动失败时可能为空。 |
| `execution.text` | 最终回复文字，可用于文本或业务检查。 |
| `execution.finishReason?` | 可选结束原因；completed 不能单独证明业务验收通过。 |
| `execution.execution.status / reason?` | 执行状态 completed / error / cancelled；可选原因如 task_timeout。优先使用此状态。 |
| `execution.status` | 执行阶段沿用的旧状态，不是当前验证脚本的判定或最终验收结论。 |
| `execution.error?` | 可选执行错误。缺省字段先判断存在或使用默认值。 |
| `execution.durationMs / iterations` | 执行耗时（毫秒）、迭代次数。 |
| `execution.usage` | inputTokens、outputTokens；可选 cacheReadTokens、cacheWriteTokens、totalCost。 |
| `execution.toolCalls` | 数组：name、input、output、durationMs、可选 error。仅供诊断，不能证明真实执行或审批合规。 |
| `execution.assertions` | 此时可能为空，不能用作最终验收结论。 |

## 读取最终回复

下载或上传 [verify-reply.mjs](../examples/grading/verify-reply.mjs)，修改 expected.contains 为实际业务要求。

```js
import { readFile } from "node:fs/promises";

// EVAL_CONTEXT is a path to the evaluator's input JSON.
const context = JSON.parse(await readFile(process.env.EVAL_CONTEXT, "utf8"));
const expected = { executionStatus: "completed", contains: "已完成" };
const actual = {
  executionStatus: context.execution.execution?.status ?? "unknown",
  text: context.execution.text ?? ""
};
const passed = actual.executionStatus === expected.executionStatus
  && actual.text.includes(expected.contains);
// stdout must contain exactly one JSON object; use console.error for diagnostics.
console.log(JSON.stringify({
  protocolVersion: 1, verdict: passed ? "pass" : "fail", expected, actual,
  message: passed ? "最终回复符合要求" : "执行未完成或最终回复不符合要求",
  evidence: []
}));
```

## 读取产物文件

下载或上传 [verify-artifact.mjs](../examples/grading/verify-artifact.mjs)，修改 summary.json 路径和 total 的期望值。文件缺失或内容错误返回 fail，无法读取上下文或脚本自身异常则属于验证错误。

```js
import { readFile } from "node:fs/promises";
import path from "node:path";

const context = JSON.parse(await readFile(process.env.EVAL_CONTEXT, "utf8"));
const expected = { total: 12 };
let actual;
let passed = false;
try {
  actual = JSON.parse(await readFile(path.join(context.workspace, "summary.json"), "utf8"));
  passed = actual?.total === expected.total;
} catch (error) {
  // Missing or malformed task output is a business failure, not a script error.
  actual = { outputError: String(error) };
}
console.log(JSON.stringify({
  protocolVersion: 1, verdict: passed ? "pass" : "fail", expected, actual,
  message: passed ? "产物满足要求" : "summary.json 缺失或 total 不等于 12",
  evidence: context.evidence.artifacts.filter(file => file.path === "summary.json").map(file => file.ref)
}));
```

## 存储与兼容性

脚本库跟随 EVAL_CASE_STORAGE。MongoDB 模式写入同库的 agent_eval_verifiers；SQLite 模式写入原有 eval.sqlite。MongoDB 部署升级时运行一次 mongo:prepare 并授予应用脚本集合读写权限，此后上传每个脚本都无需管理员操作。原有 EVAL_VERIFIERS_FILE 注册和 command 规则继续支持，新配置无需重启。

运行提交时将所用脚本源码和版本固定在本地 SQLite 运行快照，数据库断连不影响已接受的运行或快照重跑。同名上传生成新的 ID，不会替换已保存案例引用的脚本；在规则中重新选择即可切换版本。案例导出仍只引用 verifierId，迁往另一环境需要对应脚本库和 ID；历史运行导出含源码快照。

CLI 引用上传脚本时使用相同 EVAL_CASE_STORAGE 和 MongoDB 配置，或相同 SQLite EVAL_DATA_DIR；不使用上传脚本的旧 CLI 案例无需数据库。
