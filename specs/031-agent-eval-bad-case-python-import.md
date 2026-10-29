# SPEC-031：Bad case 分类与日志平台 Python 直写接入

状态：Implemented
日期：2026-10-29（北京时间）

用户澄清：普通指已经存在的单轮回放案例，不新增普通类型、执行模式或创建流程。本方案只新增可选 Bad case 信息，Python 同时支持写入已有单轮案例合同。

## 1. 目标与范围

用户在内网 Agent 日志平台选择任务中的指定轮次，将其一键保存为普通单轮案例或 Bad case 到评测系统 MongoDB。评测系统能识别 Bad case，并在点击案例后展示原始错误输出。

交付内容：案例模型、详情与必要的列表标识；兼容 SQLite/MongoDB 的存取与导出；Python 3 + PyMongo 可运行参考实现、样例输入、requirements 和接入说明；更新 MongoDB 原生建集合/修改集合/重建命令。内网日志平台自身的按钮、权限系统和具体日志字段适配由内网 Agent 开发。

不修改 SDK，不新增 MongoDB 集合或自定义索引，不迁移批次/运行配置，不自动执行评测。此前历史对话批量导入校验失败尚未确认根因，不能宣称此功能已修复该问题；本功能的写入格式必须独立通过真实 MongoDB 校验。

已阅读应用 AGENTS、内网 roadmap、SPEC-008/017/030，以及 types、schema、replay、MongoCatalog/Mongo schema、列表投影与案例详情实现。

## 2. 当前行为与缺口

- 案例已有单轮回放等 replayMode，缺少独立的 Bad case 错误输出信息；已有单轮类型直接复用。
- parseEvalSuite 显式构造案例，未知属性不会自然完整保留；只向 MongoDB 增加任意字段不能保证编辑、复制和快照保留。
- MongoDB 保存案例及模块，运行配置和批次仍在本地。外部导入必须显式传入 defaults，不能假设可从 MongoDB 获取全局运行配置。
- 案例变更通过事务更新模块 writeVersion 协调归档/案例写入，外部写入端须遵循该合同。
- 摘要接口按字段投影，错误输出不应加入首页列表正文。
- single-turn 仅接受 user/assistant 文本历史，工具关闭且模型只响应一次；function-call 可携带原生工具历史，只生成一次工具调用，不执行工具。二者不能静默互换。

## 3. 数据合同

沿用 agent_eval_cases，业务扩展位于 definition；schemaVersion 保持 1，新增可选字段，旧数据无需回填。

```json
{
  "badCase": {
    "observedOutput": "原始错误回答，或格式化后的原始响应 JSON",
    "outputFormat": "text",
    "reason": "可选：为什么这是错误输出"
  },
  "importSource": {
    "platform": "internal-agent-logs",
    "taskId": "task-123",
    "turnId": "turn-7",
    "url": "https://logs.example/tasks/task-123"
  }
}
```

- 不新增 caseKind 或 normal 类型。definition.badCase 存在即为 Bad case，不存在则完全沿用已有案例行为；replayMode 不变。
- badCase 存在时必须有 observedOutput 非空字符串；上限 1 MiB UTF-8。outputFormat 为 text / json，缺省 text；json 时必须可解析，不改变原字符串。reason 可选，最多 16 KiB UTF-8。移除 Bad case 标记时明确清除该块，不保留相互矛盾的类型字段。
- importSource 可选；存在时 platform/taskId/turnId 均为非空字符串，各最多 256 字符；url 可选，最多 2048 字符，仅允许 http/https。
- 原始错误输出可能是自由文本或包含工具调用的响应 JSON，不强制它通过“正确响应”的结构校验，也不将其中的工具调用执行。
- 错误输出不等于 llmJudge.referenceAnswer：不自动启用评分、不自动生成断言、不自动判定未来运行失败。
- 原始输出与来源进入案例完整定义，随保存、复制、转移、JSON 导入导出、运行快照保存。摘要只增加派生的 isBadCase 布尔标记，不携带 badCase/importSource 正文，也不向完整案例新增分类字段。旧记录/旧摘要缺省视为没有 Bad case 信息，不为此强制全量重建本地摘要。
- 应用解析与 MongoDB validator 对新增字段保持一致；保留已有校验，不使用 bypassDocumentValidation。首次上线使用新版应用，并由 DBA 更新 cases validator，无需删除重建集合。

## 4. 轮次切分与回放合同

Python 的核心接口接收日志平台已规范化的明确输入，不猜测内部日志结构或“轮次”含义：

1. history 只包含被选中模型响应生成之前的历史上下文。
2. prompt 是该次响应的实际输入；原始 observedOutput 不得放入 prompt/history，不能包含选中响应之后的数据。
3. taskId/turnId 标识日志平台稳定的任务及本次模型调用位置。若“业务轮次”有多次模型调用，平台适配层须明确选中哪次响应，不默认取最后一条。
4. 普通案例可以不传原始输出；Bad case 必须提供错误输出。
5. single-turn 接受 user/assistant 文本历史和可选 systemPrompt；遇到 tool/system/developer 消息不得擅自丢弃或拼成文本。系统指令可由适配层显式映射到 systemPrompt；无法等价映射时报错。
6. 需要保留工具链时显式选择 function-call；接收现有规范的原生消息、所选工具和 toolChoice。遵守工具调用/结果配对、系统消息位置、消息数量/大小限制；不支持的工具名称报错。函数历史放入 functionCall.history，普通 history 为空。

复用已有 single-turn 与 function-call 写入合同；Bad case 信息独立附加。不新增普通类型或 full-task 导入适配，不执行历史工具，不承诺现有六种工具以外的任意工具协议可原样评测。

## 5. Python 交付与写入流程

拟交付目录：apps/examples/agent-eval/examples/python-mongodb-import/。

- import_cases.py：提供写入现有单轮案例、写入带错误输出的 Bad case 两个可复用入口，共用构造/校验与事务写入逻辑，便于日志平台后台调用；普通入口不增加类型字段。
- requirements.txt：PyMongo 依赖。
- 普通文本、Bad case、包含工具历史的示例 JSON，以及 README 接入说明；使用占位地址，不含内网凭据。
- python 标准库测试及隔离 MongoDB 集成验证；Python 生成的文档还需由 TypeScript 案例解析与 MongoDB validator 双向确认。

输入包含：已有 moduleId、source、可读案例名称、replayMode、history/prompt、可选 systemPrompt/functionCall/badCase、显式 defaults（providerId/modelId 及现有可选连接配置）。Mongo URI 从运行环境读取，database/collection 可配置；说明 ma_table 是用户当前实际数据库，agent_eval 为仓库默认值，二者不能混用。

默认不创建模块：要求传入评测系统已有模块的真实字符串 ID，不按名称猜测或自动插入。代码不建表、不建索引、不 collMod，不读取本地 SQLite，也不写运行历史或 verifiers。

写入过程：

1. 本地完整校验参数、角色/工具链、长度和序列化大小，构造符合现有 SavedCase 合同的文档。_id 为字符串 UUID，revision 初始 1，createdAt/updatedAt 为 UTC BSON 日期，archived 为 false，schemaVersion 为 1。
2. 使用稳定 UUIDv5 从固定命名空间及 moduleId + platform + taskId + turnId + 导入入口（已有案例 / Bad case）派生 _id；以无歧义 JSON 编码组合，不用分隔符拼接。导入入口仅用于去重，不作为案例类型字段存储。同一轮次可分别通过两个入口保存；同一入口重复点击对应同一文档。
3. 在 MongoDB 事务中读取/验证目标模块、拒绝已归档模块，按现有协议递增模块 writeVersion；缺失或格式错误时停止，不隐式补写模块结构。
4. 查找确定性 _id；已有未归档文档且规范化业务内容完全一致则返回 unchanged。比较排除日期、revision 等生成字段；已编辑、归档或内容不同则返回 conflict，不覆盖、不自动递增版本。提供冲突文档 ID 便于平台展示。
5. 检查模块内活动 definition.id 名称冲突；不同来源同名返回 conflict。插入案例，与模块协调写入同事务提交。
6. 返回 created / unchanged / conflict 及 caseId/moduleId。使用 PyMongo 事务重试机制；遇提交结果不确定时使用同一确定性 ID 只读核对，无法确认则明确 unknown，不能盲目报成功或换新 ID 重试。

无自定义 unique 索引时，默认 _id 唯一性保障相同导入身份去重；同模块应用与参考 Python 实现的 writeVersion 协调保障遵循协议的常规名称检查。不能宣称可约束不遵守协议的任意外部写入者。

运行账号权限：启动/检查所需 listCollections，以及案例/模块的必要 find/insert/update；不申请 createIndex、collMod、drop 或 bypassDocumentValidation。MongoDB 仍需支持事务的副本集/分片集群，不支持时明确报错，不降级为半成功写入。

## 6. 界面与兼容性

- 案例列表仅对 Bad case 增加一个轻量标识；增加普通/Bad case 筛选，不在列表展示错误输出、来源任务 ID 或内部 UUID。
- 案例详情支持附加/移除 Bad case 信息，已有回放方式选择保持；Bad case 显示“原始错误输出”区域，提供只读原文查看/复制、可编辑错误输出与原因。大文本限制区域高度，按详情加载，使用文本渲染，避免当 HTML 执行。不新增普通案例模式或单独创建流程。
- 明确标注“来自日志平台的原始输出”，与本次执行结果、Judge 参考答案分开。
- 来源 platform/taskId/turnId 在详情展示，可选来源 URL 可打开；列表仍不显示 session_id。
- 新建、编辑、复制、JSON 导入导出、SQLite/Mongo 切换使用一致解析；旧案例默认普通案例。旧应用版本会丢弃新增字段，升级说明要求写入新类型前先升级应用。
- 外部写入后刷新列表可见，不新增推送服务或实时同步协议。

## 7. 错误处理与 MongoDB 命令

- Python 把 Unauthorized、DocumentValidationFailure、重复键、模块不存在/归档、业务冲突、连接异常、提交结果未知区分返回。
- 对 code 121 提供受控诊断：写入阶段、集合名、字段路径及失败规则；不默认输出 errInfo 中的 consideredValue、整条日志、连接串或密钥。适用版本没有详细校验信息时保留 code 和阶段，不能伪造字段原因。
- 同步 caseValidator 与 create/update/rebuild 三份 TXT，模块/脚本的规则保持。新规则允许缺少新增字段的旧文档，新增字段存在时严格校验。
- 应用启动继续仅检查集合存在；不恢复 validator/index 检查、不自动修改数据库。
- 不通过清空用户数据库解决校验错误；本次验证只能用隔离测试库。

## 8. 验收标准

1. 普通/Bad case 的 single-turn、function-call 样例均能由 Python 插入真实 MongoDB，通过 validator，并被新版 Web 列表/详情读取和运行。
2. Bad case 原始输出可查看与复制；不进入被测模型请求、不被当成参考答案，也不自动改变评测状态。
3. 编辑、复制、移动、导出再导入、运行快照不丢失新增字段；SQLite 旧案例可用，MongoDB 旧记录可用。
4. 重复点击返回同一案例且 unchanged；内容被修改时返回 conflict，归档目标拒绝；同来源并发导入不重复插入，无需自定义索引。
5. 缺字段、非法日期/角色/工具链、超长输出、无权限、121 校验失败和事务失败可定位，失败事务不留下案例或模块部分更新。
6. 首页摘要不包含大体积错误输出；相关类型检查、构建、针对性 UI/存储测试及 Python/真实 Mongo 集成通过。
7. 原生命令与源码 validator 一致；文档说明升级顺序、实际数据库名、必要权限、日志平台适配边界和函数调用模式限制。

## 9. 实施步骤与确认

用户确认后：记录 Approved → 模型/解析/存储和原生命令 → 列表/详情 → Python 接入示例 → 针对性测试及隔离 MongoDB 验证 → 说明与交付 → 标记 Implemented。未经要求不提交推送、不接入或操作用户内网数据库。

用户于 2026-10-29 明确“继续实施”，批准调整后范围；现已完成。

## 10. 实施与验证记录

2026-10-29：按用户确认的范围实施。未新增普通类型/回放模式；新增可选 badCase/importSource 字段、轻量摘要标记和筛选、详情错误输出查看/编辑/复制、Python 两个入口与三份样例。未修改 SDK，未创建自定义索引，未连接内网数据库。

- TypeScript 类型检查、构建通过。
- Web + case-origin 回归：78 pass、0 fail（包含真实 MongoDB 8.0 副本集集成）。
- 补充 SDK 输入隔离及首次并发导入后，针对性回归：14 pass、0 fail，94 assertions；Python 5 项单元测试通过，命令行 validate-only 通过。
- Python 真实 MongoDB 验证：现有单轮、Bad case、工具历史三份输入通过实际 validator，并经 TypeScript 解析读回；重复导入 unchanged，首次并发一份 created/一份 unchanged，同名/修改/归档返回冲突。分别注入 cases 与 modules 校验拒绝，返回 insert-case / touch-module，事务回滚且没有部分写入。此验证不是内网实际账号 RBAC 验证。
- 桌面 1440px 与手机 390px 浏览器验证通过：筛选、详情、编辑保存、来源保留、文本安全渲染及无页面横向溢出；摘要不含原始输出正文。预览截图在 /workspace/work/spec031-desktop.png 与 spec031-mobile.png。
- Web 冒烟通过，0 failures。
- 完整应用回归：154 pass、1 skip、2 fail，1363 assertions。两项失败均为既有 importable-examples 清单断言：仓库 HEAD 已含 function-call-editor-flexible.json 及两个案例，但测试预期未更新。已通过 git diff --quiet HEAD 核对该示例和该测试未被本次修改；不将全量回归宣称为全绿。跳过项是 Windows 进程树超时测试。
- 原生 create/update/rebuild TXT 与源码 validator 一致性测试通过；不增加任何索引命令。已有库更新 cases 即可，不需删除重建。MongoDB maxLength 计字符，应用/Python 额外限制 UTF-8 字节和 JSON 格式；接入说明明确外部写入合同。

交付路径：apps/examples/agent-eval/examples/python-mongodb-import/；包含依赖、代码、测试、普通单轮/Bad case/工具历史样例及可交给内网 Agent 的接入任务说明。部署需先升级应用，DBA 按实际库名（用户为 ma_table）更新 cases 规则。运行账号不需要 DDL 权限。未自动提交推送。
