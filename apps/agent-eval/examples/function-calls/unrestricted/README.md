# 六工具不限调用次数验证器

分别上传本目录的 `verify_read_files.py`、`verify_search_codebase.py`、`verify_run_commands.py`、`verify_fetch_web_content.py`、`verify_editor.py`、`verify_skills.py`。每份都是独立标准库脚本，入口为 `verify(ctx)`，不依赖相邻文件。

默认参数使用 `{}` 即可：目标工具只要实际出现，调用一次或多次均可，不设置精确次数、次数范围或总次数约束，也没有旧脚本的 15 条处理上限。`expected_count`、`min_count`、`max_count`、`expected_total_calls` 在本版本一律忽略，旧案例遗留这些字段也不会限制次数。

仍逐条验证本轮全部实际调用的封装、唯一 ID、工具名、参数 JSON 和公开 Schema。任意一条错误均失败；没有 tool_calls 或未包含本脚本的目标工具也失败。默认允许本轮公布的工具；若只能调用目标工具，例如 editor，可填 `{"allowed_tools":["editor"]}`。不执行工具，不将历史工具调用计入本轮。

平台最多接受 100 个检查项，因此返回一项全部校验汇总和最多 95 项明细，失败优先。省略的只是报告明细，所有调用仍参与校验，包含末尾调用。汇总提供实际调用数、目标调用数、检查数量、失败数和省略明细数，完整响应仍在本轮原始证据中。

这是独立新版本，不覆盖上一级旧脚本。上传时建议名称加“不限次数”，在案例中选择新的验证器。模型请求仍只有一次；响应大小、执行超时等平台限制仍然适用，不代表可处理无限大的输入。

从 agent-eval 根目录检查：

```sh
python examples/function-calls/test_unrestricted.py
bun run scripts/generate-function-call-verifiers.ts --check
```
