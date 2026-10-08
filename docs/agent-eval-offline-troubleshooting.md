# Agent Eval 内网迁移与 SDK 加载问题排查记录

本文记录本次 Windows PowerShell 内网部署遇到的问题、已确认的原因和解决方式。用户已确认当前环境可以运行；本文不代表所有自动化测试均已通过。

## 1. 环境与目录约定

- 运行环境：Windows、PowerShell、Bun 1.3.13；仓库要求 Node.js ≥22。
- 应用目录：`apps\examples\agent-eval`。
- 五个 SDK 包：`shared`、`llms`、`agents`、`core`、`sdk`。模型包的目录名是 `llms`，不是 `llm`。
- 源码目录：`sdk\packages\<包名>`。
- 本次内网采用的安装目录：根目录 `node_modules\@cline\<包名>`，使用复制的包文件。

下文以仓库根目录为相对路径起点。排查命令注明在 `agent-eval` 目录执行时，可这样取得根目录：

```powershell
$repo = (Resolve-Path ..\..\..).Path
```

## 2. Web 能打开，但不代表 SDK 可以执行评测

### 现象

Web 页面能启动，但观察到 `node_modules` 中 `@cline`、`@types` 目录似乎为空，无法确认依赖是否完整。

### 分析

Web 在执行评测时通过 worker 加载 SDK，因此页面启动成功不能替代 SDK 加载和实际评测检查。

Bun workspace 安装还可能使用符号链接。原外网仓库中的示例链接为：

```text
apps/examples/agent-eval/node_modules/@cline/sdk
  -> ../../../../../sdk/packages/sdk
```

ZIP 解压、跨系统复制可能影响链接，但本次没有证据确认“空目录”本身就是链接丢失，不能只根据目录外观判定缺包。

`@types` 主要用于类型检查，缺失可能影响构建；SDK 运行时是否能加载需要单独检查。

### 检查方式

在 `apps\examples\agent-eval` 创建 `check-sdk.mjs`：

```javascript
console.log("Bun version:", Bun.version);
console.log("Working directory:", process.cwd());

try {
  console.log("SDK path:", import.meta.resolve("@cline/sdk"));
  const sdk = await import("@cline/sdk");
  console.log("ClineCore type:", typeof sdk.ClineCore);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
```

执行：

```powershell
bun run .\check-sdk.mjs
```

预期输出包含 `ClineCore type: function`。仅能解析出 SDK 路径还不够，必须完成实际导入。

## 3. PowerShell 执行内联 JavaScript 报语法错误

### 现象

执行以下命令时出现 `expected "class" but found "/"`：

```powershell
bun -e 'console.log(import.meta.resolve("@cline/sdk"))'
```

### 处理与结论

改用上一节的 `.mjs` 文件执行，成功得到 Bun 版本、工作目录和 SDK 路径，随后暴露了真正的 SDK 导出错误。

命令行引号传递是当时的疑点，但没有单独验证其具体机制。已确认有效的处理方式是使用脚本文件，避免多层命令行转义。这个语法错误不能作为 SDK 缺失的证据。

## 4. SDK 报缺少 resolveClineConfigDirName 导出

### 现象

```text
SyntaxError: Export named 'resolveClineConfigDirName' not found in module
...\node_modules\@cline\shared\src\storage\index.ts
```

SDK 本身解析到：

```text
node_modules\@cline\sdk\dist\index.js
```

但出错模块却是 shared 的 `src`，不是 `dist`。

### 排查过程

1. 重新构建五个 SDK 包并复制到根目录 `node_modules\@cline` 后，用户确认曾恢复运行。
2. 后续更新 shared，再次遇到相同缺少导出的错误，说明仅复制构建产物仍未解决所有路径问题。
3. 检查安装目录 shared 的 `package.json`，确认 `./storage` 正确指向 `./dist/storage/index.js`，无需修改此入口。
4. 检查仓库 shared 源码，确认函数在 `src/storage/paths.ts` 中定义，并由 `src/storage/index.ts` 导出。
5. 对比源目录与安装目录两份 `dist/storage/index.js`，SHA-256 完全一致，且均包含函数名。这排除了该文件未同步的可能，但“包含函数名”本身不等于运行时导出验证。
6. 检查误带入安装目录的 core 开发配置，并将其改名禁用后，用户确认 SDK 检查成功。

### 已确认的根因

开发用的配置原本位于：

```text
sdk\packages\core\tsconfig.json
```

复制整个 core 开发目录时，它也进入了：

```text
node_modules\@cline\core\tsconfig.json
```

该配置包含开发时的路径映射：

```json
{
  "compilerOptions": {
    "paths": {
      "@cline/shared/storage": ["../shared/src/storage/index.ts"]
    }
  }
}
```

在本次 Bun 运行环境中，这份配置使 shared 的导入重定向到了安装目录中的源码：

```text
core/dist 导入 @cline/shared/storage
  -> 安装目录中 core/tsconfig.json 的 paths 映射
  -> node_modules/@cline/shared/src/storage/index.ts
  -> 旧源码缺少调用方需要的导出
```

同步脚本只更新 `dist`，实际加载的却是旧 `src`，所以重复复制 `dist` 无法修复。

### 已验证有效的修复

先停止 Web。在 `apps\examples\agent-eval` 的 PowerShell 中执行：

```powershell
$repo = (Resolve-Path ..\..\..).Path
$coreConfig = Join-Path $repo 'node_modules\@cline\core\tsconfig.json'

Move-Item -LiteralPath $coreConfig -Destination "$coreConfig.disabled"
bun run .\check-sdk.mjs
```

改名后 Bun 不再将该文件识别为 `tsconfig.json`，本次加载恢复使用 shared 的包导出入口，进入正确的 `dist/storage/index.js`。

注意：

- 只处理安装目录中的配置，保留 `sdk\packages\core\tsconfig.json`，它仍用于开发。
- 已改名成功后无需重复执行；如果已有 `.disabled` 文件，先检查，不要覆盖备份。
- 本操作基于本次“安装目录是复制包”的环境。如果 `node_modules` 中包目录是链接，先确认链接目标，避免改动源码目录。
- 不需要虚构同名函数、修改正确的 shared `exports` 或清空全部依赖。

## 5. 后续 SDK 更新流程

### 构建

在仓库根目录、构建依赖齐全的环境执行：

```powershell
bun run build:sdk
```

SDK 包之间通过构建产物解析依赖。修改源码后要重新构建；运行中的进程不会自动加载新的 SDK 产物，需要重启。

### 同步

仓库根目录的 `sync-sdk-dist.ps1` 用于将五个包的 `dist` 同步到根目录 `node_modules\@cline`：

```powershell
.\sync-sdk-dist.ps1
```

也可以指定仓库：

```powershell
.\sync-sdk-dist.ps1 -RepoRoot 'D:\workspace\cline'
```

脚本行为：

- 预检五个源目录及目标包。
- 完整替换 `dist`，避免混入旧文件。
- 将旧 `dist` 备份至 `.sdk-dist-backups`。
- 对检查到的符号链接/junction 停止处理。
- 替换失败时尝试回滚。

**脚本不修改 `package.json`、`src` 或 `tsconfig.json`，也不安装新增依赖。** 包导出或依赖声明变化时，必须同步匹配的完整发布包，不能只同步 `dist`。脚本生成时仅做过静态检查，没有在本地 Windows PowerShell 实际运行验证。

正式迁移建议使用包声明的发布内容及其完整运行依赖，不再将整个开发目录复制进 `node_modules`。同平台准备依赖，并保留依赖目录结构和有效链接。现有 `agent-eval` 发布压缩包不包含全部第三方依赖，不能直接当作完整离线环境。

### 验证

在 `apps\examples\agent-eval` 执行：

```powershell
bun run .\check-sdk.mjs
bun run smoke:web
bun run web
```

三层验证分别是：

1. SDK 实际导入成功。
2. 本机模拟模型接口的 Web 冒烟测试，覆盖队列、worker、SDK、结果等链路。
3. 使用内网网关运行真实评测用例。

本次用户确认禁用误带入配置后检查成功、环境可以运行；对话中未提供 `smoke:web` 的完整通过输出。

## 6. 内部模型网关配置

对于 OpenAI 兼容 Chat Completions 网关，Web「运行配置」填写：

| 字段 | 示例 |
|---|---|
| Provider | `openai-compatible` |
| 模型 Model | 网关实际接受的模型或部署 ID |
| 密钥环境变量 | `INTRANET_LLM_KEY`，填写变量名，不是密钥 |
| Base URL | 如 `https://gateway.internal/ai/v1` |

若完整请求地址是 `https://gateway.internal/ai/v1/chat/completions`，Base URL 不包含末尾 `/chat/completions`。

当前 PowerShell 会话设置密钥并启动 Web：

```powershell
$env:INTRANET_LLM_KEY = '替换为真实密钥'
bun run web
```

永久保存为当前用户环境变量：

```powershell
[Environment]::SetEnvironmentVariable('INTRANET_LLM_KEY', '替换为真实密钥', 'User')
```

永久设置后重新打开终端并重启 Web；若使用 VS Code 内置终端，必要时重启 VS Code。已运行的进程不会自动获取新设置。

全局配置不会追溯修改已保存案例。创建评测时可取消勾选「使用案例保存的配置（默认来自全局配置）」，再检查实际运行配置。

首次验证使用 `single-turn` 和禁用工具的简单案例；代码任务要显式选择 `full-task`。

用户还提出网关需要额外 HTTP Headers。**这项能力尚未在本次会话实现**：当前 Web 没有自定义 Header 输入项，设置 API Key 环境变量也不会自动增加任意自定义 Header。后续需根据脱敏请求示例补充配置和请求传递。

## 7. Base64 迁移文件

本次生成了根目录的：

- `agent-eval.zip.base64`
- `restore_agent_eval.py`

在内网将二者放在同一目录，执行：

```powershell
python .\restore_agent_eval.py
```

脚本通过 Python 标准库还原 ZIP，并校验生成脚本时记录的 SHA-256；默认不覆盖已有 ZIP。可指定其他输出文件：

```powershell
python .\restore_agent_eval.py -o restored-agent-eval.zip
```

生成时已实际还原并确认与原 ZIP 逐字节一致。校验只能证明传输还原一致，不能证明 ZIP 已包含全部运行依赖或跨平台链接可用。

## 8. 本次排查的关键结论

**定位依赖问题时，先看实际加载路径，再看构建文件是否同步。** 本次不是简单的“shared 没有编译”，而是安装目录中的开发配置使运行时加载了旧源码。禁用该配置后，已同步的构建产物才真正被使用。
