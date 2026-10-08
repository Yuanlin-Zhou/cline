# 判分规则示例

完整的可导入案例索引、最终回复/任务结果/工具行为验收表格和配置片段见 [`../README.md`](../README.md)。

`ui-examples.json` 包含六个完整任务案例，可从案例模块的导入入口导入 JSON，无需注册验证器。运行需要已有模型配置，使用完整工具范围和空工作区副本。

| 案例 | 按提示执行后的预期 |
|---|---|
| grading-json-pass | 通过：JSON 文件存在、total=12、items 包含 2 |
| grading-text-pass | 通过：文本包含、排除、正则及临时文件不存在 |
| grading-tolerance-pass | 通过：数值误差在容差内 |
| grading-missing-fail | 失败：只回复完成，未生成文件 |
| grading-value-fail | 失败：实际 10，预期 12 |
| grading-behavior-optional | 文件通过；可选行为规则显示证据不足 |

两个负例的提示故意与验收条件不同，用于检查判分器能否识别失败。实际结果仍取决于 Agent 产物；可选行为规则不影响整体判定。当前 SDK 不支持真实行为证据，将其改为必要规则会触发预检拒绝。

原有 `suite.json` 演示注册脚本 `summary-v1`，需按主 README 的验证器说明配置 `verifiers.json`。
