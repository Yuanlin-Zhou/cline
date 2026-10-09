# Agent Eval 可导入示例与验收方式

## 直接导入

启动 Web 服务后，进入 **案例集 → 导入案例**，选择目标模块和 JSON 格式，将下列文件内容粘贴到导入框即可。四个案例集均不固定模型供应商、模型 ID 或密钥，导入时继承当前 Web 设置；导入不会自动运行案例。

| 文件 | 数量 | 内容 | 运行前提 |
|---|---:|---|---|
| `importable/single-turn.json` | 8 | 历史上下文、命令、计算和格式回答 | 有效模型配置；单轮固定不使用工具 |
| `importable/full-task.json` | 5 | 文件创建、工作区检查和编码测试 | 有效模型配置；在隔离工作区使用完整工具 |
| `importable/grading.json` | 6 | 文件、文本、JSON、数值容差及可选行为诊断 | 有效模型配置；无需额外验证器 |
| `importable/registered-verifier.json` | 1 | 文件规则与独立验证脚本组合 | 另需配置 `grading/verifiers.json` |

合计 20 个唯一案例，覆盖旧 `examples/*.json`、判分示例、Web 导入页内置示例和 `multi-turn.ts` 的对话场景。`multi-turn-project-requirements` 将已完成的前两轮写入 `history`，只运行最后一个 `prompt`；它验证上下文回放，不会重新调用模型执行历史轮次。

`registered-verifier.json` 可以直接导入，但运行前需要从 `apps/examples/agent-eval` 配置：

```bash
export EVAL_VERIFIERS_FILE="$PWD/examples/grading/verifiers.json"
bun run web
```

## 三层验收

| 层次 | 配置位置 | 验收对象 | 适合检查 |
|---|---|---|---|
| 最终回复验收 | `assertions` | Agent 最终回复文字和结束原因 | 是否提到必要信息、是否出现禁用内容、格式是否匹配 |
| 任务结果验收 | `grading.rules` 中的 `file.*`、`command`、`script` | Agent 结束后的工作区快照和独立验证结果 | 文件是否真正生成、内容是否正确、测试或业务验证是否通过 |
| 工具行为验收 | `grading.rules` 中的 `tool.*` | 按因果顺序记录的真实工具事件与审批事件 | 是否调用、参数、顺序、审批后执行；当前实时运行不支持，详见能力边界 |

不要用最终回复中的“已完成”代替产物验收。需要证明文件或程序结果时，应使用任务结果规则。

## 最终回复验收

| 字段 | 通过条件 | 示例 |
|---|---|---|
| `contains` | 最终回复包含数组中的每个字符串，区分大小写 | `"contains": ["Bun", "通过"]` |
| `notContains` | 最终回复不包含数组中的任何字符串 | `"notContains": ["npm"]` |
| `matches` | 最终回复匹配数组中的每个 JavaScript Unicode 正则 | `"matches": ["v[0-9]+"]` |
| `finishReason` | 实际结束原因等于期望值 | `completed`、`max_iterations`、`aborted`、`mistake_limit`、`error` |

非 grading 案例即使省略 `assertions`，也会检查 `finishReason` 默认为 `completed`。配置了 `assertions` 时，所有条件都必须通过。grading 案例可以同时配置 `assertions`，此时回复断言会作为必要规则与任务结果规则一起判定。

```json
{
  "id": "answer-uses-bun",
  "replayMode": "single-turn",
  "history": [
    { "role": "user", "content": "这个项目使用 Bun。" },
    { "role": "assistant", "content": "明白。" }
  ],
  "prompt": "应该用什么命令安装依赖？",
  "assertions": {
    "contains": ["bun install"],
    "notContains": ["npm install"],
    "matches": ["bun\\s+install"],
    "finishReason": "completed"
  }
}
```

## 任务结果验收

任务结果规则只能用于显式的 `"replayMode": "full-task"`。规则默认是必要规则；只有写出 `"required": false` 才是可选诊断。

| `kind` | 关键字段 | 通过条件 | 常见用途 |
|---|---|---|---|
| `file.exists` | `path` | 结束时指定普通文件存在 | 交付物必须生成 |
| `file.absent` | `path` | 结束时指定文件不存在 | 不得留下临时文件、调试产物 |
| `file.unchanged` | `path` | 文件运行前后都存在，且 SHA-256 相同 | 保护输入、锁文件或配置文件 |
| `file.text` | `path`, `op`, `expected` | UTF-8 文本满足包含、排除或正则条件 | README、源码、纯文本报告 |
| `file.json` | `path`, `pointer`, `op`，部分方式需要 `expected`/容差 | JSON 可解析且目标值满足比较条件 | 结构化输出、统计值、数组成员 |
| `command` | `verifierId`, `expectedExitCode` | 已注册验收程序的退出码等于期望值 | 测试命令、lint、外部校验程序 |
| `script` | `verifierId` | 已注册脚本退出 0，并按协议返回 `verdict: "pass"` | 需要结构化预期值、实际值和证据的业务验收 |

`path` 必须是工作区内的安全相对文件路径，不支持绝对路径、`..` 或通配符。`file.text` 和 `file.json` 最大读取 1 MiB；工作区证据快照上限为 5000 个文件或 100 MiB。证据缺失、截断或不完整不会让必要规则静默通过。

### 文本比较

| `op` | 通过条件 | 示例 |
|---|---|---|
| `contains` | 文件包含 `expected` 字符串 | README 包含 `Bun` |
| `notContains` | 文件不包含 `expected` 字符串 | README 不包含 `npm` |
| `matches` | 文件匹配 `expected` 正则 | `^v[0-9]+$`；JSON 中反斜杠需要转义 |

### JSON 比较

`pointer` 使用 JSON Pointer：空字符串表示整个 JSON，`/items/0/name` 表示数组首项的 `name`；字段名中的 `/` 写为 `~1`，`~` 写为 `~0`。

| `op` | `expected` | 通过条件 |
|---|---|---|
| `exists` | 不需要 | Pointer 指向的字段存在；值为 `null`、`false` 或 `0` 也算存在 |
| `equals` | 需要 | 类型和值严格相等；数字 `12` 不等于字符串 `"12"` |
| `contains` | 需要 | 字符串包含子串，或数组包含一个严格相等的成员 |
| `matches` | 字符串正则 | 目标值是字符串且匹配正则 |
| `approx` | 有限数字 | 数值误差不超过 `max(absTolerance, relTolerance × abs(expected))`；至少配置一种非负容差 |

```json
{
  "id": "summary-artifact",
  "replayMode": "full-task",
  "history": [],
  "prompt": "创建 summary.json，写入 total=12 和 items=[1,2,3]。",
  "grading": {
    "version": 1,
    "rules": [
      {
        "id": "summary-exists",
        "kind": "file.exists",
        "path": "summary.json"
      },
      {
        "id": "total-is-12",
        "kind": "file.json",
        "path": "summary.json",
        "pointer": "/total",
        "op": "equals",
        "expected": 12
      },
      {
        "id": "items-has-2",
        "kind": "file.json",
        "path": "summary.json",
        "pointer": "/items",
        "op": "contains",
        "expected": 2
      }
    ]
  }
}
```

### 验收程序与验证脚本

`command` 和 `script` 都通过 `verifierId` 引用程序，案例不能内嵌 shell 命令。用户可在案例的“判定规则 → 使用验证脚本”中直接上传 .js/.mjs/.ts 文件，立即选用，无需管理员注册或重启；原有 `EVAL_VERIFIERS_FILE` 配置继续支持。两者都在证据快照的独立副本上运行：

- `command`：退出码等于 `expectedExitCode` 时通过；其他退出码是明确失败。
- `script`：进程必须退出 0，stdout 必须是一个协议 JSON，其中包含 `protocolVersion: 1`、`verdict`、`expected`、`actual`、`message` 和 `evidence`。`verdict: "fail"` 是明确失败；非零退出、超时、无效 JSON、协议错误或输出截断是验证错误。

上传步骤、字段说明和无需依赖的模板见 [验证脚本上传指南](../docs/uploaded-verifiers.md)。注册表及完整脚本示例见 `grading/verifiers.json`、`grading/verify-summary.ts` 和 `importable/registered-verifier.json`。

## 工具行为验收

| `kind` | 关键字段 | 设计语义 |
|---|---|---|
| `tool.count` | `match`, `min`/`max` | 匹配到的唯一工具调用次数在范围内 |
| `tool.parameters` | `match`, `check` | 至少有一个匹配调用，且每个匹配调用的输入都通过 JSON Pointer 比较 |
| `tool.order` | `before`, `after`, `requireAfter` | 同一会话中，匹配的 `before completed` 先于不同调用的 `after started`；`before` 未写 `outcome` 时只接受成功完成，且默认要求存在 `after` |
| `tool.approval` | `match` | 每次匹配的 `started` 事件之前都有同一工具调用的批准事件；没有匹配执行时条件为空真，不证明工具执行过 |

`match` 支持以下字段：

| 字段 | 含义 |
|---|---|
| `name` | 工具名称，精确匹配 |
| `phase` | `requested`、`started` 或 `completed` |
| `outcome` | 仅 `completed` 可用：`success` 或 `error` |
| `parameters` | 可选；使用与 `file.json` 相同的 Pointer 比较筛选工具输入 |

行为诊断示例：

```json
{
  "id": "read-after-write-diagnostic",
  "kind": "tool.count",
  "required": false,
  "label": "至少读取一次结果文件",
  "match": {
    "name": "read_files",
    "phase": "started",
    "parameters": {
      "pointer": "/paths/0",
      "op": "equals",
      "expected": "summary.json"
    }
  },
  "min": 1
}
```

如果任务还要求工具至少执行一次，不要只写 `tool.approval`；应再添加一条相同 `match`、`min: 1` 的 `tool.count` 必要规则。若 `tool.order.before` 没有显式填写 `outcome`，判分器会按 `outcome: "success"` 匹配，失败的前置调用不满足顺序条件。

### 当前能力边界

当前实现刻意不修改 SDK，而现有 SDK 没有提供判分所需的完整真实工具/审批事件；运行时能力 `requested`、`started`、`completed`、`approval` 均为不可用。因此：

- 必要行为规则会在创建执行前被拒绝，避免把缺失证据误判为通过或失败。
- `"required": false` 的行为规则可以保存和运行，但结果为 `insufficient`（证据不足），不改变整体 verdict。
- 单元测试用合成事件验证规则算法，只证明判分逻辑，不代表实时 Agent 已具备行为证据。

## 规则状态与整体结论

| 规则状态 | 含义 |
|---|---|
| `pass` | 证据完整且条件满足 |
| `fail` | 证据完整且条件明确不满足 |
| `error` | 验证器故障、超时、协议错误或判分过程异常 |
| `insufficient` | 证据或能力不足，不能可靠判断 |
| `skipped` | 验证被取消或未执行 |

整体结论只看必要规则：

| 条件 | verdict |
|---|---|
| 任一必要规则为 `fail` | `failed` |
| 至少一条必要规则，且全部为 `pass` | `passed` |
| 没有明确失败，但必要规则含 `error`、`insufficient` 或 `skipped` | `inconclusive` |

可选规则无论通过、失败还是证据不足，都只提供诊断，不改变整体结论。执行错误与取消单独统计，不应混入任务通过率。任务通过率按已判定案例计算：`passed / (passed + failed)`。
