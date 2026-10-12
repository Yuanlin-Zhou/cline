# 带历史输入的 editor 单轮函数调用案例

`cases.json` 提供 6 个案例；每个包含两轮已完成的 `history`（user/assistant 各两条）和当前 `prompt`。模型只处理当前一轮，历史不会重新执行。使用 `function-call` 模式、`toolChoice=auto`，只公布 editor，不执行实际文件操作。

| 案例 ID | 历史提供的信息 | 本轮输入与正确调用 |
| --- | --- | --- |
| `editor-history-create` | 目标文件尚不存在、路径、两行中文内容与末尾 LF | 创建约定文件；path/new_text 精确匹配，old_text/insert_line 省略或 null |
| `editor-history-replace` | 已存在配置全文、只允许改端口 | old_text 为 `PORT=3000` 加 LF，new_text 为 `PORT=8080` 加 LF；不使用 insert_line |
| `editor-history-insert` | 三行文件内容、在 build 之前插入 | insert_line=2，new_text 为 `test` 加 LF；不使用 old_text |
| `editor-history-append` | 文件恰好两行、待追加内容 | insert_line=3，new_text 为 `v3: improve` 加 LF |
| `editor-history-latest-request` | 原路径 old.txt、原内容 OLD，尚未执行 | 本轮取消旧计划，只创建 final.txt，内容 FINAL 加 LF |
| `editor-history-two-files` | 两个文件全文与局部替换条件 | 同一响应两个 editor 调用，先 a.env 再 b.env；只替换 ENABLED 行 |

期望参数在每个案例的 `grading.rules[0].params.expected_calls` 中，可以直接查看和修改。`new_text` / `old_text` 中 JSON 的 `\n` 表示真实的一个 LF 换行，不是反斜杠和字母 n；校验不会 trim，也不会替换 CRLF，文件末尾换行必须符合要求。

## 上传、绑定、导入

先启动 Web 服务，并在运行配置选择 OpenAI-compatible，填写模型 ID、兼容服务 baseUrl 和密钥环境变量。从 agent-eval 根目录执行：

```bash
python3 examples/editor-single-turn/prepare.py \
  --url http://127.0.0.1:3130 \
  --output editor-single-turn-bound.json
```

随后在 **案例集 → 导入案例**，选择目标模块，将 `editor-single-turn-bound.json` 的内容作为 JSON 导入，然后运行。原始 `cases.json` 中的 `example-editor-scenarios` 是待绑定占位，先执行准备脚本再导入运行；不需要管理员注册或重启。

也可手动上传 `verify_editor_scenarios.py`，导入模板后将每条规则绑定到该上传脚本。准备脚本只上传这个专用验证器，不上传其他工具验证器，也不会自动执行模型。

Windows 可使用 `python` 命令，并将示例命令写成一行。服务使用其他端口时调整 `--url`。

## 如何判定“正确”

专用脚本为独立单文件、仅标准库，入口 `verify(ctx)`：

1. 检查本轮完整原生响应、工具名、调用数量、id/type、arguments JSON 及 editor 公布的 Schema。
2. 按 `expected_calls` 的顺序逐项比较 path/new_text/old_text/insert_line，返回字段级 expected/actual。
3. 可选 old_text/insert_line 的预期为 null 时，接受省略或 null；其他字段严格比较类型和值。使用旧路径、错误内容、错行号、多余的替换/插入操作均不能通过。

通用 `examples/function-calls/verify_editor.py` 只校验格式，填错业务内容可能仍符合格式。本套案例使用专用脚本，格式正确但参数错误会判为 fail。缺少原始响应时显示 insufficient，不从历史文字或模型“已完成”声明推断通过。

此处检验模型能否根据上下文生成正确的 editor 参数，不检验工具实际执行、文件是否修改成功，或项目环境中的文件是否存在。文件内容与存在状态由历史输入明确给出。

“结果与断言”会展示本轮模型响应，再展示参数对照；可复制或下载原始响应。脚本试验证使用固定历史结果，不会再次请求模型。

## 本地验证

```bash
python3 examples/editor-single-turn/test_examples.py
```

测试覆盖六例正确输出、路径/内容/换行/行号错误、沿用被取消的旧计划、两调用顺序与数量错误，以及缺失原始响应。没有模型凭据也可验证案例和脚本是否自洽；真实模型是否通过应在实际服务中评测。

脚本内嵌当前 editor Schema 和通用格式验证逻辑。SDK 公布结构更新后，需要同步该脚本与 `examples/function-calls/verify_editor.py` 的基线，再重新上传绑定；不会动态读取 SDK 或相邻 Python 文件。
