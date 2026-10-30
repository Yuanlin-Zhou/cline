# SPEC-033：Python 直接从完整 messages 导入回放 / Bad case

状态：Implemented
日期：2026-10-30（北京时间）

## 1. 目标与当前差异

用户已有完整的 Agent 对话 messages，希望 Python 写入 MongoDB 前，按照网页“历史对话 JSON（批量生成案例）”的规则生成历史、当前输入与案例，不再手工拆分 history/prompt。

当前 Python 的 single-turn/history 仅支持 user/assistant 文本；function-call/functionCall.history 支持 system/developer/user/assistant/tool 和现代 tool_calls/tool_call_id，但要求已转换的原生消息及明确 prompt，不提供网页完整记录解析与自动续接能力。网页转换由 function-call-history.ts、batch-conversations.ts 实现。

已阅读 SPEC-017/018/031/032、现有 Python 入口、网页转换和消息校验。此方案只补齐 Python 接入能力，不修改 SDK、前端、执行模式、数据库结构、索引或已有 Bad case 展示。

## 2. 新入口与输入

新增 import_case_from_conversation / import_bad_case_from_conversation，保留现有 import_single_turn_case / import_bad_case，旧参数和去重身份不变。

新入口的 payload 形态：

```json
{
  "moduleId": "已有模块的字符串ID",
  "source": { "platform": "internal-agent-logs", "taskId": "task-123", "turnId": "turn-7" },
  "name": "任务123-第7轮-Bad case",
  "conversation": {
    "messages": [
      { "role": "system", "content": "项目使用 Bun。" },
      { "role": "user", "content": "如何安装依赖？" },
      { "role": "assistant", "content": "请执行 npm install。" }
    ]
  },
  "badMessageIndex": 2,
  "badCase": { "observedOutput": "请执行 npm install。", "reason": "忽略项目使用 Bun" },
  "options": { "tools": ["editor", "run_commands"], "continuation": "继续" },
  "defaults": { "providerId": "openai-compatible", "modelId": "实际模型名称" }
}
```

- conversation 接受与网页相同的记录对象或消息数组；支持 messages、现有拼写别名 messgaes（两者不能同时存在）、标准 role/content、type/data 包装及网页已支持的 Cline 原生消息。
- moduleId/source/name/defaults 沿用现有含义；新入口默认生成已有 function-call 案例，外层 history 为空，原生历史写入 functionCall.history。不新增回放模式。
- options 复用网页的 tools/toolChoice/continuation/ignoreThinking 语义，tools 缺省为现有六种工具、toolChoice 缺省 auto、continuation 缺省“继续”；系统指令来源冲突时沿用网页显式 systemSource 选择规则。
- Bad case 仍明确传 badCase.observedOutput，不猜测某条内容必然错误，不自动把历史回复当参考答案。Bad case 示例可来自选中回复的文本或 JSON，由日志平台提供。
- badMessageIndex 是原始 conversation 消息数组的零基下标，选中消息须为可识别的助手回复。完整记录包含要评测的错误回复时必须填写；工具 ID、平台 turnId 不能直接当数组下标。
- 不允许同时传新入口的 conversation 与旧入口的 history/prompt/functionCall，以免来源优先级模糊。

## 3. 截取边界与网页一致性

两种明确的调用方式：

1. **传入的对话已是响应之前的输入历史**：不传 badMessageIndex，完整保留对话，按网页批量导入规则处理最后一条消息。Bad case 的错误输出另传。
2. **完整记录包含被选中的错误回复及后续消息**：传 badMessageIndex，取该条助手消息之前的前缀，再对该前缀执行同样的网页规则。被选中的错误回复以及其后消息均不进入回放输入，返回截取范围与数量说明。

共同规则：

- 前缀/完整历史实际末条是普通纯文本 user 时，将该条提取为 prompt，仅此前消息保留为 history；不搜索更早的 user 来截断。
- 末条是 assistant、tool 或含工具结果的 Cline user 时，保留全部已选历史，prompt 使用 continuation，明确返回已追加续接文案的通知。这沿用网页执行合同，不宣称与原始无用户输入的工具触发请求逐字一致。
- system/developer 保留正确位置，现代 tool_calls/tool_call_id 保留 ID、参数和结果配对，Cline 按网页转换原生 content blocks；未知角色/不支持的多模态、旧 function_call/function 角色、断裂工具链明确报错，不拼成普通文本或静默丢弃。
- 文件/消息数量、UTF-8 大小、重复 JSON 键、系统消息冲突、思考处理等沿用网页现有规则。返回 notices、转换来源和边界，便于日志平台展示预览。
- 转换后的 historySource 与 functionCall.history 对应，保留原始来源索引；Python 构造/校验层补充现有 historySource 合同，不修改 MongoDB validator。

## 4. 实现与数据库兼容

在 Python 目录增加独立的对话读取/转换模块，按已有 TypeScript 实现移植，作为普通/Bad case 新入口共用前处理；后续仍调用既有构造和事务写入逻辑，不依赖评测 Web 服务、Bun/Node 子进程或内网日志平台的特定字段。

MongoDB 文档保持现有合同：definition.replayMode=function-call、functionCall.history/historySource、prompt、可选 badCase/importSource。现有集合、字段校验和索引要求不变。继续检查目标模块，事务更新 writeVersion，稳定 UUIDv5 去重；同一轮已有内容不同仍返回 conflict，不自动覆盖。

扩充示例：system + user/assistant、tool_calls + tool 结果、Cline、type/data/messgaes、已截取输入、含错误回复的完整记录。README 直接给出两个新函数调用方式及可交给内网 Agent 的适配说明，说明这是 Python 参数而非网页案例集 JSON。

## 5. 异常处理

错误明确指出消息/内容块路径。索引越界、选中非助手消息、工具链不完整、系统来源冲突、参数混用等在写库前失败，不留下部分写入。CLI 不回显整段对话或凭据。预览成功不等同数据库已允许写入；保留现有 unauthorized/validation-failed/conflict/unknown 分类。

## 6. 验收

1. Python 接收完整记录，自动构造与网页一致的原生历史与 prompt，不要求日志平台逐条转换 system/工具调用。
2. 用同一组输入和选项，对比 Python 与现有 TypeScript 的 history、prompt、historySource 与 notices；包含网页现有三份格式样例、工具结尾、助手结尾、系统冲突、思考处理和无效工具链。
3. badMessageIndex 截取后，错误回复及后续消息不进入模型输入；错误输出独立保存在 badCase，现有案例详情与结果页可展示。
4. 新普通/Bad case 入口写入真实隔离 MongoDB 后可被应用解析，重复导入/内容冲突和事务失败行为不变；旧 Python 用法继续可用，不新增 DDL 或自定义索引。
5. Python 测试、TypeScript 对照、类型检查、构建及相关存储回归通过。没有前端改动，不改变界面布局。

## 7. 实施步骤

用户确认后 Approved → Python 转换与前处理 → 对照样例与失败路径验证 → 新入口及 CLI/文档 → 隔离 MongoDB 写入与旧入口回归 → 记录并标记 Implemented。未经要求不提交推送，不连接内网库。

用户于 2026-10-30 明确“继续实施”，批准上述范围；现已完成。

## 8. 实施与验证记录

2026-10-30：已实施。新增 conversation_history.py 纯 Python 读取/转换模块；共享原生历史与严格 JSON 校验，原 import_cases 的 helper 名称仍可导入。新增 build_conversation_document、preview_conversation_case、import_case_from_conversation、import_bad_case_from_conversation 和 --conversation CLI 参数；保留旧入口和去重命名空间。旧手工入口增加可选 historySource 校验，便于共用已有文档合同。

- 标准 messages/数组/JSON 字符串、messgaes、type/data、Cline 原生内容块、system/developer、调用别名、结构化工具结果、文件内联文本和思考处理，按现有网页规则转换。
- badMessageIndex 必须指向原始助手消息，截取其之前的输入；排除错误回复与未来消息。截取后为空时明确拒绝，不能伪造原始输入。已截取前缀省略索引时，notice 明确提醒调用方确认未混入错误回复或未来消息。错误输出仍显式独立传入，不猜测答案。
- 统一返回 boundary 与 notices，预览函数不连接数据库；CLI 仅输出结构化状态与边界，不打印完整历史。新增 6 份可运行参数样例和完整接入说明，明确两份 Python 模块须一起复制。
- 原生历史大小按紧凑 JSON 计算以对齐网页；严格 JSON 校验同时拒绝浮点与超大整数溢出。工具参数编码对齐 JSON 的数字表示、整数键顺序与 Unicode 文本。

验证结果：

1. Python 单元及 CLI 回归：18 项通过（包含原 5 项），覆盖新旧入口、标准工具完整对话、Cline 选择错误回复、截取边界、输入混用、未知选项、错误 provider、重复 JSON 键、工具链、historySource、CLI validate-only 和失败不回显原文。
2. 与现有 TypeScript 网页实现直接对照：44 组场景通过，包括有效数据和无效数据；比较 history、prompt、historySource、notices、originalCount 与 boundary。纯转换测试只依赖 Python 标准库，不依赖 Bun/Node 子进程作为交付运行时。
3. 相关存储/重试/MongoDB 回归：23 pass、0 fail，287 assertions。补充整数溢出负例后的最终对照及 Python Mongo 集成：3 pass、0 fail，127 assertions。
4. 真实隔离 MongoDB 8.0 副本集验证：新普通/Bad case/Cline/type-data 入口写入实际 validator 后可被 TypeScript 解析，historySource 与历史对应；错误回复和后续消息未进入输入。重复导入 unchanged、不同内容 conflict；索引错误在写库前失败；DB 规则拒绝时返回 validation-failed 且案例与模块事务完整回滚。旧入口并发去重、归档/编辑冲突等测试继续通过。此验证不代表内网实际账号权限验证。
5. 类型检查、构建、Python 编译和 git diff --check 通过。没有前端实现改动，无需新增 UI 布局复核或更改 MongoDB 原生命令；未连接内网数据库、未调用真实模型。

交付目录：apps/examples/agent-eval/examples/python-mongodb-import/；测试日志 /workspace/work/spec033-tests.log、spec033-final-tests.log；新版接入包 /workspace/output/agent-eval-python-mongodb-import.zip。未经要求不提交推送。
