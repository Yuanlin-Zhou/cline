# Cline Agent Eval 发布包

此包包含评测工具的 JavaScript 编译产物、示例配置，以及从本地仓库打包的五个 Cline SDK 包。无需克隆整个 Cline 仓库。它不是单文件 EXE；第三方运行依赖需要首次联网安装。

## Windows PowerShell

解压后，在包含 `package.json` 的目录执行：

```powershell
bun install --production --ignore-scripts
bun run start --help
$env:CLINE_API_KEY = '你的 API Key'
bun run start examples/basic.json --output results/basic.json
```

使用 Bun 1.3.13。API Key 只保存在环境变量中，不要写入用例或发布包。

## 输入与权限

编辑 `examples/basic.json`：`history` 放入之前的 user/assistant 消息，`prompt` 是当前要执行的提示词。历史只是上下文，不会重新执行之前的任务；如果历史声称创建了文件，需要自行准备相应工作区。

`defaults.providerId`、`modelId`、`apiKeyEnv` 指定模型及密钥环境变量名。`defaults.baseUrl` 可指定兼容服务地址。

- `tools: "none"`：纯对话。
- `tools: "read-only"`：仅开放文件读取、代码搜索（默认）。
- `tools: "full"`：自动批准命令和文件修改，只用于可信的独立测试工作区。这不是操作系统沙箱。

JSON 中的 `cwd` 相对用例文件所在目录解析；命令行 `--cwd` 相对当前终端目录解析。每个用例使用新会话，但相同 cwd 的文件状态会保留，不会自动回滚。

```powershell
bun run start examples/basic.json --cwd 'D:\my-test-workspace' --stream
```

输出 JSON 包含最终文本、结束原因、工具调用、token、成本和断言结果。`--stream` 的实时文本发送到 stderr。默认断言要求正常完成，也可以设置 `contains`、`notContains`、`matches` 和期望的 `finishReason`。

退出码：0 表示所有用例通过；1 表示存在失败/出错用例；2 表示输入或配置错误。正式调用模型会产生提供商费用。运行日志和报告可能包含输入或工具读取的内容，请勿公开敏感数据。
