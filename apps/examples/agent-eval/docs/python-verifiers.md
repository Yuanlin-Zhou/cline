# Python 验证脚本

在案例详情的“判定规则”启用验收，添加“使用Python验证脚本”规则，上传 UTF-8 `.py`（最大 1 MiB）。保存案例后立即生效，无需管理员注册或重启。单轮回放可检查回复与会话；读取文件需要完整任务模式。

## 最小脚本

```python
def verify(ctx):
    keyword = ctx["params"].get("contains", "已完成")
    text = ctx["execution"]["text"]
    passed = ctx["execution"]["status"] == "completed" and keyword in text
    print("回复字符数:", len(text))
    return {
        "verdict": "pass" if passed else "fail",
        "message": "最终回复包含指定内容" if passed else "回复不符合要求",
        "checks": [{"id": "reply", "status": "pass" if passed else "fail",
                    "message": "检查最终回复", "expected": keyword, "actual": text}]
    }
```

脚本定义普通函数 `verify(ctx)`，返回可 JSON 序列化的字典。`verdict` 为 `pass`、`fail` 或 `insufficient`，`message` 为文字；`checks` 可选，其每项包含唯一 `id`、同样三种 `status`、`message`，可附 `expected`、`actual` 和相对文件路径数组 `files`。总体通过时检查项也必须全部通过。`print()` 和异常堆栈进入验证日志，不占用结果协议。异常、非法返回值、超时属于验证错误；证据缺少用 `insufficient`，业务不符用 `fail`。

## 输入字段（context_version = 2）

| 字段 | 内容与读取方式 |
| --- | --- |
| `execution` | `status`、`text`、`finish_reason`、`error`、`duration_ms`、`iterations`、`usage`；执行状态与最终回复，不包含验证结论。 |
| `conversation` | `status`、`completeness`、`issues`、`messages`。消息包含 `role` 和 `blocks`；文字块为 `type=text/text`，工具请求为 `type=tool_call/input`，工具结果为 `type=tool_result/output`。参数和结果保留 JSON 类型。 |
| `artifacts` | `status`、`files`、`deleted`；文件有 `path/size/sha256/change`，变化为 added/modified/unchanged。 |
| `baseline` | 初始文件的 `status/files`，文件有 `path/size/sha256`。 |
| `paths` | `artifacts/baseline/scratch/context/diagnostics` 的绝对路径，本次验证的独立副本。 |
| `diagnostics` | `tool_calls/capabilities/events_ref`，JSONL 事件副本位于 `paths.diagnostics`。 |
| `case` | 固定的 `id/prompt/history/replay_mode`。 |
| `run` | `run_id/item_id/round/session_id`。 |
| `params` | 规则中填写的 JSON 对象，默认 `{}`。 |

读取产物示例：

```python
from pathlib import Path

def verify(ctx):
    if ctx["artifacts"]["status"] != "ready":
        return {"verdict": "insufficient", "message": "需要完整且已归档的产物"}
    root = Path(ctx["paths"]["artifacts"])
    files = [f for f in ctx["artifacts"]["files"] if f["path"].endswith(".txt")]
    passed = bool(files) and all("hello world" in (root / f["path"]).read_text(encoding="utf-8") for f in files)
    return {"verdict": "pass" if passed else "fail", "message": "检查所有txt文件"}
```

读取会话文字：遍历 `ctx["conversation"]["messages"]`，按 `role` 筛选，再遍历 `blocks`，读取 `type == "text"` 的 `text`。会话来自 SDK 保存的主会话上下文，压缩后可能缺失早期消息，完整性为 `unknown`；工具通知不能证明实际执行或审批。请检查每个输入的 `status/completeness/issues`，不要把缺失证据当作通过。

规则可填写必需输入 `required_inputs`（默认 execution）和要求完整的输入 `require_complete`；缺少或不完整时系统直接返回证据不足。单轮回放的 artifacts/baseline 为 not_applicable。要求完整会话时，当前 SDK 上下文不能满足该要求。

## 历史结果试验证

规则卡片中选择已结束的历史执行，先“查看实际输入”或下载 JSON，再“开始试验证”；结果详情也有“脚本试验证”。试验证可以停止，可查看逐项检查、预期/实际值和日志。不调用模型，不覆盖原评测结果。

新执行在验证前冻结输入，脚本和各规则拿到独立文件副本。旧执行只能利用已保存的结果和归档产物，会话未冻结时明确标记缺失，不读取后来变化的工作区或会话文件。预览不含当前规则参数和验证临时路径，执行时由系统注入。

## Python 环境

服务端需要 Python 3.10+；设置 `EVAL_PYTHON_EXECUTABLE` 指向 Python 或虚拟环境解释器，默认检测 python3/python。不自动安装依赖，第三方包需预先安装到所选环境。启动时不强制要求 Python：仍可上传脚本；缺少环境时页面提示，执行前拦截。

系统保存解释器与已安装包的环境指纹；运行和重跑需要相同环境，环境变化会提示重新配置/新建评测。默认每脚本 60 秒，正常评测的验证阶段还受总超时限制。日志最多 stdout/stderr 各 1 MiB，结果最大 1 MiB；日志截断不影响有效结果。

Python 用隔离模式 `-I` 执行，不继承模型密钥环境变量；文件副本不是操作系统沙箱。只上传可信代码。依然支持原有 JS/TS 上传与配置注册的验证程序，旧协议见 [uploaded-verifiers.md](uploaded-verifiers.md)。
