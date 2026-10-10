# SPEC-011：Python 验证脚本与统一评测上下文

- 状态：**Implemented / 已实施**
- 确认记录：2026-10-09（北京时间），用户回复“很好，继续实施”，批准本方案全部首期范围。
- 日期：2026-10-09（北京时间）
- 基线：`work` 分支 `4671654`，工作区干净。
- 来源：用户要求直接上传 Python 脚本，自定义检查执行结果、会话记录和执行产物；方案获用户批准后实施。
- 关联：根目录 SPEC-009、SPEC-010，历史 SPEC-001，以及 `docs/agent-eval-intranet-roadmap.md`。

## 1. 目标与范围

让用户上传一个 `verify.py`，编写 `def verify(ctx): ...` 即可进行业务验证。平台负责准备该次执行的数据、调用 Python、采集日志、验证返回值、展示检查明细和固定版本。用户不需要编辑服务器注册文件、启动命令、系统路径或 stdout JSON 协议。

支持单轮回放的回复/会话验证，以及完整任务的回复/会话/文件验证。Python 新接口不修改 SDK 和工具行为判分能力。原有 JS/TS 上传与管理员配置注册验证器继续兼容；Python 为默认下载模板和新增上传推荐格式。

首期支持单文件 UTF-8 `.py`（1MiB），Python 3.10+、标准库。允许维护者配置已有虚拟环境解释器，使用其已安装依赖；不在上传或执行时自动 pip 安装。依赖环境、容器执行、多文件包及重新正式判分不是首期范围。提供基于历史执行的试验证，避免每次调试脚本都重跑模型。

## 2. 当前行为与问题

- `uploaded-verifiers.ts` 拒绝 `.py`，MongoDB validator 也只允许 `.js/.mjs/.ts`；上传记录没有运行时/接口类型。
- `materializeVerifiers()` 把所有上传源码交给 Bun，运行时选择依赖扩展名以外的固定假设。
- `verifyProcess()` 已准备产物快照副本和 `EVAL_CONTEXT`，但 context 只有 execution/rule/evidence/workspace，没有会话输入；脚本必须输出唯一协议 JSON，普通 print 会破坏协议。
- Python 可以经管理员注册运行，但不满足用户自行上传的操作路径。截图中的“Python”是配置注册脚本，不代表上传已经支持 Python。
- SPEC-010 会话接口是带分页、展示文字和媒体省略的 Web 视图；它读取可变化的 SDK 上下文文件，不是冻结的验证输入，也不适合作为唯一业务数据接口。
- 当前 script 规则没有 params，单轮模式不允许任务验收；新增 Python 脚本需明确适用范围，而不是无条件放开全部任务规则。
- SDK 会话上下文可能压缩；当前 sparse evidence events 与最近30项 activity 不等于完整会话/完整工具轨迹。

## 3. 用户操作路径

案例 → 判定规则 → 使用 Python 验证脚本 → 下载模板/选择 `.py` → 上传并自动选中 → 可选填写参数 → 保存。

规则卡片优先提供：

1. Python 脚本选择与上传，不要求用户提供服务端命令。
2. “下载最小模板”“下载文件验证示例”“下载会话验证示例”。
3. “查看输入数据”：字段说明、示例 JSON，以及选中历史执行的实际输入预览。大文件只显示清单和预览，不塞入浏览器 JSON。
4. “试验证”：选择该案例的某次历史执行，使用已保存/刚上传的脚本和当前参数试运行；显示逐项结果、耗时、日志、异常栈，不调用模型，不覆盖历史结论。明确提示正在验证历史输入，并不证明当前已修改案例的模型行为。

单轮模式只允许检查 execution/conversation/diagnostics，产物区显示“不适用”；完整任务模式包含产物和基线。旧脚本入口保留在兼容选项中。后端返回 Python 就绪状态、版本、依赖环境标识；没安装解释器时可以上传，保存的案例标记运行前配置缺失，新运行预检拒绝发起模型请求。

## 4. Python 编写接口

标准入口：

```python
def verify(ctx):
    return {
        "verdict": "pass",  # pass / fail / insufficient
        "message": "满足业务要求",
        "checks": []         # 可选逐项检查
    }
```

`ctx` 是普通 Python dict；内含标准 JSON 数据和本次验证副本的目录路径。用户可自由使用 pathlib/json/csv/re 等标准库和已安装依赖，不要求继承基类或导入额外 SDK。

平台 runner 从 context.json 加载数据、通过 runpy 加载上传模块、查找并调用 verify(ctx)，检查返回字典，写入独立 result.json。Python 使用参数数组直接启动，不经 shell；以 `-I -u` 运行，指定解释器支持已有虚拟环境的 site-packages，避免用户目录/PYTHONPATH 混入。runner 和上传源码位于产物副本外。

入口调用前就捕获脚本 print/stdout/stderr 到日志，返回值走结果文件；普通 print 不污染业务协议。捕获模块加载、函数执行和序列化异常，显示为“脚本错误”。用户无需填写 protocolVersion、evidence IDs 或手动 emit JSON；平台为返回结果添加版本、来源、脚本摘要与上下文摘要。

如需读取二进制、CSV 或较大产物，直接读取 `ctx["paths"]["artifacts"]` 下的文件，不把文件内容全部塞进 ctx。

## 5. 输入合同 v2

| 字段 | 内容与边界 |
| --- | --- |
| `context_version` | 2，与旧 JS/TS protocolVersion:1 分离 |
| `run` | run_id/item_id/round/session_id；每次重复执行各有自己的输入 |
| `case` | 此次运行固定的 id/prompt/history/replay_mode；不含当前案例的新编辑内容 |
| `params` | 当前 script 规则的可选 JSON 参数，默认 {} |
| `execution` | status（completed/error/cancelled）、text、finish_reason、error、duration_ms、iterations、usage；不含该脚本结果或最终 grading，避免循环输入 |
| `conversation` | status、source、completeness、issues、messages；用户/模型/工具消息以及结构化内容块 |
| `diagnostics` | 工具诊断 tool_calls、可用的事件文件、completeness、issues、capabilities；不把 SDK 通知伪装成实际执行/审批证据 |
| `artifacts` | status（ready/partial/not_applicable）、files；每个文件有 path/size/sha256，added/modified/unchanged，以及删除清单 |
| `baseline` | 对应执行前的文件清单与状态，可比较任务前后 |
| `paths` | artifacts/baseline/scratch/context：本次验证的独立目录，不暴露原始执行工作区、数据库或原始 SDK 日志目录 |

消息模型：`{id, index, role, timestamp?, agent_id?, blocks}`。block 保留 `type=text/tool_call/tool_result/...`，工具参数和结果保留为原始 JSON 类型：`tool_name/tool_call_id/input/output/error`；不转成 Web 展示字符串。模型文本 block 使用 text。图片/附件只提供可用元数据和受控副本引用，不在 ctx 内展开 base64。

本期会话以主 session 已保存上下文为来源，包含初始 history 和任务输入。子会话若未采集，标注 scope=main_session 与 coverage 信息，不能把主会话冒充全部 Agent 会话。未知完整性使用 unknown；已检测压缩/截断使用 partial，缺失使用 missing，不能因为成功读取 JSON 就标 complete。

为了让完整任务的早期工具/文本过程可供检查，在 agent-eval runner/worker 层归档 SDK 已公开的 text/tool/iteration/end/error 通知（含序号、时间、agent/session 标识），生成有上限的独立诊断 JSONL。保留内容边界，文本 chunk 与 final text 去重，关联已有 toolCallId；不使用最近活动列表替代诊断。不重建或猜测 SDK 没有提供的用户交互/执行事件，不修改 SDK。与会话上下文分别提供，避免拼接出虚假的完整对话。

上下文保存时沿用已有凭据替换范围，不增加 SDK 日志脱敏改造。缺失、截断、被替换或无法支持的字段记录在 issues 中，用户可按业务需求返回 insufficient。

## 6. 冻结数据与执行顺序

模型 worker 结束并完成落盘 → 读取执行结果、SDK 会话和诊断 → 归档会话/诊断快照及摘要 → 归档工作区/基线 → 创建 validation-input-v2.json → 运行验证器 → 汇总结果。

必须在所有验证器运行前完成公共输入冻结。Python 和 Web 会话查看共用读取/规范化基础层，但分别生成业务合同与展示视图；脚本不调用 Web API、不访问实时会话文件、不受分页限制。归档内容按现有 evidence/blob 哈希引用保存；冻结后网页验证预览优先查看相同快照。

公共输入不含其他验证器写入的日志/结果，避免后跑脚本看到不同的模型材料。每个脚本有独立的 artifacts/baseline 副本和 scratch；可以操作自己的副本，但不能修改已归档的判分证据。路径字段仅在运行时生成，不存入 MongoDB 脚本库。

已有单次读取/归档上限保留明确约束：会话32MiB、工具诊断4MiB、产物现有5000文件/100MiB；超限明示 partial/missing，不静默变成空集合。归档不完整不继续伪造完整副本；首期依赖产物的脚本在准备阶段返回输入不足。纯回复检查不应因为不需要的会话或文件缺失而被整体禁止。

规则可声明 `required_inputs`（execution/conversation/artifacts/baseline/diagnostics），默认 execution；UI 提供选项。声明的数据不可用时平台返回 insufficient，不执行脚本；available 但 completeness=unknown/partial 的数据由脚本按业务判断，不能自动宣称完整。明确需要完整数据时另加 `require_complete` 声明，未知也视为不足。

取消时沿用现有停止验证语义，不强行再启动 Python；已归档的部分输入可供用户之后试验证。异常/超时执行若已归档且没有取消，可以交给 Python 检查 execution.status，但脚本 pass 不覆盖既有任务预算等硬性失败。

## 7. 返回值、结果展示与异常

verdict 必填 pass/fail/insufficient，message 必填字符串。checks 可选，每项 `{id, status, message, expected?, actual?, files?}`，status 为 pass/fail/insufficient，files 为相对产物路径。平台校验类型、重复 ID、路径、JSON可序列化性与大小；声明整体 pass 却包含失败/不足的明细属于协议错误，避免自相矛盾。文件引用由平台关联既有证据 ID，用户无需知道内部 ID。

- 业务条件不满足：fail。
- 缺少必要会话/证据、覆盖不足：insufficient。
- Python 不可用、语法/导入错误、未定义 verify、函数异常、非字典返回、非法返回、超时：error，与模型业务失败分开。
- 被取消：skipped/cancelled，保留已有日志。

首期保持既有总判分语义：fail 对应失败；必要规则不足不能报告通过；脚本故障展示为验证错误。多项 checks 是同一 script 规则的明细，不改变 required 权重和通过率分母。

结果页展示脚本总体结论、逐项 expected/actual、相关文件入口、日志/异常栈、脚本版本、Python环境版本和 context 摘要。完整报告保存为证据；页面大字段预览截断且标注，不能把截断预览当作全部输入。

默认脚本超时60秒，沿用验证总预算180秒、进程树终止与取消。结构化返回文件最多1MiB；日志延用上限，日志截断仅影响日志展示，不能因用户 print 较多而误判有效 result.json。非零退出、缺少结果或清理失败仍算脚本错误。

## 8. Python 环境与存储兼容性

服务配置 `EVAL_PYTHON_EXECUTABLE`，可指向 python.exe/python3 或虚拟环境解释器；未配置时按平台尝试 python3/python。配置若显式无效不偷偷回退。启动预检实际执行版本探测，确认3.10+；每次新运行预检复核就绪状态。上传可做单独限时 py_compile/AST 语法检查，不 import 用户模块、不执行顶层语句。

运行记录固定脚本源/hash、接口版本、Python路径/版本/解释器摘要、可取得的依赖环境清单和环境摘要。Python解释器检查和依赖清单属于部署工具链，不承诺仅哈希python.exe就能证明整个环境一致。重跑/试验证发现声明环境不一致时明确报错或要求选择新的验证版本，不默默换环境。无需逐个脚本管理员注册；部署时一次准备Python环境。

MongoDB 模式的 `.py` 源码仍存 `agent_eval_verifiers`；SQLite 模式继续存 records.verifier。扩展 extension enum 和可选 runtime/entrypoint/contractVersion 元数据：新Python记录 runtime=python、entrypoint=verify、contractVersion=2；旧记录无新字段按Bun/v1解释。schemaVersion 不必因添加可选字段强制重写旧文档；解码时校验语言与扩展名、接口组合一致。

MongoDB `mongo:prepare` 更新 validator，同时允许旧、新记录并存；现有部署升级时准备一次，不要求每次上传准备。新的运行快照包含上述元数据，旧 JS/TS 源码快照照常执行，离线历史仍不依赖 MongoDB。单文件源码无需 GridFS。

权限沿用当前本机应用边界。运行进程使用必要系统环境，不继承模型密钥/Mongo连接等环境；注册验证器保留原有显式 env 机制。独立文件副本保证证据不被普通写文件操作改动，但不是操作系统沙箱；共享服务或不可信上传若需要限制宿主访问，应另配容器/受限进程执行后端，不声称 -I 等价于安全隔离。

## 9. 接口和代码改动

- 扩展 `POST/GET /api/verifiers`：`.py`、runtime/contractVersion与校验状态；字段默认兼容旧客户端。
- 新增 `GET /api/verifiers/runtime-status`：公开Python就绪状态、版本和环境标识，不返回解释器绝对路径或环境变量值。
- script 规则新增可选 params/required_inputs/require_complete；Python脚本的单轮规则走专门能力预检，其他任务/文件规则保留既有限制。
- 新增该次运行的验证输入预览/下载接口，以及 `POST /api/runs/:run/items/:item/verifier-tests`：指定已上传 verifierId 和 params/输入要求，先创建独立试验证任务再异步执行，返回202。GET testId 获取进度/报告；POST testId/cancel 取消。
- 历史试验证不改原 RunItem/Grade，不改历史通过率；试验证记录保存在现有本地结果存储并关联原 item。新运行可固定完整context；旧运行尽力读取现有证据，不能用执行结束后已变化的工作区替代归档，缺失时提示重新评测。
- `uploaded-verifiers.ts`/Mongo准备脚本：存储兼容扩展；`verifiers.ts`：按语言选择运行时与合同；新增 Python runner 和 context-exporter；`run.ts`：冻结会话/诊断；`engine.ts`：输入要求、明细与旧合同适配；前端增加Python模板、输入预览和试验证。

## 10. 标准库示例

检查执行完成、会话里至少有模型回复、所有产物 `.txt` 包含 hello world；没有txt也失败。会话不可用时返回不足。

```python
from pathlib import Path

def verify(ctx):
    if ctx["conversation"]["status"] != "ready":
        return {"verdict": "insufficient", "message": "缺少会话记录"}

    root = Path(ctx["paths"]["artifacts"])
    files = [f["path"] for f in ctx["artifacts"]["files"]
             if f["path"].lower().endswith(".txt")]
    bad = [name for name in files
           if "hello world" not in (root / name).read_text(encoding="utf-8")]
    replied = any(m["role"] == "assistant"
                  and any(b["type"] == "text" and b.get("text", "").strip()
                          for b in m["blocks"])
                  for m in ctx["conversation"]["messages"])
    checks = [
        {"id": "execution", "status": "pass" if ctx["execution"]["status"] == "completed" else "fail",
         "message": "执行正常结束", "actual": ctx["execution"]["status"]},
        {"id": "conversation", "status": "pass" if replied else "fail",
         "message": "会话中有模型文本回复", "actual": replied},
        {"id": "txt", "status": "pass" if files and not bad else "fail",
         "message": "存在 txt 产物且全部包含 hello world",
         "actual": {"files": files, "invalid": bad}, "files": files},
    ]
    passed = all(c["status"] == "pass" for c in checks)
    print("检查了", len(files), "个 txt 文件")  # 会进入验证日志
    return {"verdict": "pass" if passed else "fail",
            "message": "验收通过" if passed else "验收未通过", "checks": checks}
```

示例配套设置 required_inputs=[execution,conversation,artifacts]，并在前端展示正常/无txt/内容不符/会话缺失的输入与返回对照。它检查的是“存在模型回复”，不是用会话缺少某个工具事件证明工具从未执行。不能解码的txt会报脚本错误；若业务允许其他编码，用户可明确编写对应逻辑。

## 11. 验收与实施步骤

1. `.py`上传即时选中、保存、重启持久化；Mongo/SQLite兼容、旧JS/TS与注册Python回归通过。
2. 真实worker完成后，脚本读到此item的最终回复、已冻结会话和产物副本；跨轮次/跨案例不串数据，hash可核验。
3. 语法错误/缺解释器在模型请求前暴露；异常、依赖缺失、非法返回、超时、取消与业务失败区分。
4. print不污染结果；检查明细显示正确；产物副本被脚本修改不改变原始证据；输入大小/覆盖不足明确报告。
5. 标准库示例正例通过，空产物与错误内容失败，会话缺失不足；工具调用输入/output结构化保留。
6. 单轮无产物的回复/会话脚本可执行；选用要求产物的脚本时预检明确拒绝。
7. 历史试验证不请求模型、不覆盖原结论，可以取消，旧数据缺失不回退到可变化文件。
8. Windows/Linux Python启动、虚拟环境、路径空格、UTF-8、进程树清理测试；相关类型检查、Mongo合同和Web浏览器验证通过。

实施顺序：v2合同与模板 → Python运行时/存储兼容 → 会话与诊断冻结 → Python调用和结果明细 → 前端上传/预览/历史试验证 → 端到端验收及STARTUP更新。

后续独立扩展：受控依赖环境、多文件验证包、容器隔离、全量子会话归档、正式重新判分。首期不以自动安装依赖或修改SDK作为前置条件。


## 12. 实施与验证记录

已在 `work` 分支实施：`.py` 上传与 MongoDB 校验器、Python 运行环境预检/指纹、v2 固定输入、结构化会话与事件归档、按规则分开的文件副本、Python 返回值与逐项检查、日志证据、历史试验证/取消/输入下载，以及前端模板和文档。未修改 SDK 源码。

2026-10-09 验证：

- Bun 1.3.13 类型检查和编译通过；`git diff --check` 通过。
- 全量测试（专用 MongoDB 8.0 副本集）：86 pass、1 skip、0 fail，581 次断言。跳过项为 Windows 进程树测试，当前 Linux 环境没有验证 Windows；Windows 和虚拟环境部署仍应在目标机器验收。
- Python 6 项测试覆盖语法/环境不符/缺解释器、固定会话与文件、模板正负例、缺失输入、print 与截断日志、异常/矛盾输出/超时/取消、真实 SDK 模拟模型流程，以及旧历史不读取变化的会话。
- MongoDB 8 项测试全部通过，包含 Python 元数据持久化和旧脚本快照重跑。
- Chromium 实际页面检查通过：下载模板、上传即时选中、保存、单轮执行、检查明细、输入预览、历史试验证、刷新后选择保留；试验证无模型调用，无页面异常。
- `smoke:web` 通过；`smoke:release` 指向本项目编译目录的运行验证通过（仅验证编译产物及现有 SDK 依赖，未生成/验收独立发布包）。

文档：`apps/examples/agent-eval/docs/python-verifiers.md`、`STARTUP.md`、`README.md`；旧 JS/TS 协议文档继续保留。已有 MongoDB 集合需执行一次 `mongo:prepare` 更新校验器。旧记录缺少固定会话时明确标记缺失；试验证保持原结论不变。
