# 本地验证 web fetch 流式 UI

这个入口会实际下载图片、上传到本地模拟 VQA 服务，并使用正式的 SSE 解析、工具更新事件和 web fetch 卡片。模拟正文是固定测试文本，**不是真实识图结果**。不需要文档网站扫码或 VQA 凭据；让 Cline 发起工具调用仍使用你已有的主模型配置。

## 启动

在仓库根目录执行：

```sh
cd apps/vscode
bun run dev:web-fetch-preview
```

默认图片为仓库自带的 Cline 图标。也可指定自己的 PNG、JPEG 或 WebP（不超过 5 MB）：

```sh
bun run dev:web-fetch-preview /absolute/path/to/image.png
```

服务仅监听 `127.0.0.1:43127`，只提供选定的图片，不开放目录浏览。浏览器打开 `http://127.0.0.1:43127/sample.png` 可检查图片是否可访问。已有服务运行时无需重复启动。

## 打开开发版扩展

本次修改已构建。后续修改源码时，从 `apps/vscode` 重新运行：

```sh
bun run build:webview
bun esbuild.mjs
```

VS Code 的“运行和调试”选择 **Run Extension (Web Fetch Preview)**，按 F5。在新开的 Extension Development Host 中打开 Cline，新建任务。该配置使用已有构建产物，不自动构建，也不切换你的主模型账号。

将以下提示词发送给 Cline：

```text
请调用 fetch_web_content 工具读取下面的本地图片，这是用于检查流式 UI 的测试服务：
http://127.0.0.1:43127/sample.png
prompt 使用“请解析图片内容”。不要改用浏览器、命令行或其他工具。
工具返回后简短确认测试结束即可；其中内容是模拟输出，不要当作真实识图结论。
```

期望：没有扫码窗口；web fetch 卡片在工具结束前开始显示“本地模拟输出”；正文逐步增长，约十一秒后完成，主模型随后继续回答。

## 验收场景

- **自动滚动**：内容超过卡片高度时跟随新增文本。向上滚动应保持阅读位置；回到底部后继续跟随。
- **中途报错**：换成 `http://127.0.0.1:43127/sample.png?scenario=error`，约两秒后应标记解析未完成并保留已有正文。如果主模型重试，要求它不要重试。
- **取消**：换成 `http://127.0.0.1:43127/sample.png?scenario=slow`，出现文字后点击停止。卡片应结束解析状态，已收到的文字仍可阅读。
- **多个 URL**：同次请求 success 与 error 两个 URL，检查卡片中的来源和正文分开展示。现有宿主队列会串行处理这些请求。

## 关闭与排查

在服务终端按 Ctrl+C，并关闭测试扩展窗口。普通启动配置没有启用此入口；生产构建也不会启用它。

- 图片返回乱码而没有模拟正文：确认选择了上述专用 F5 配置，并使用非 production 的 `bun esbuild.mjs` 构建。它设置 `IS_DEV=true` 和 `CLINE_WEB_FETCH_PREVIEW=1`；两者缺一都不会进入预览路径。
- 连接失败：确认服务正在运行，且端口 43127 未被其他程序占用。固定使用 `127.0.0.1`，不要替换为 `localhost`。
- 工具未被调用：先确认 Cline 主模型可以正常聊天；该测试入口只替换图片/VQA 路径。
- 提示本地 webview dev server 未运行：开发模式会回退到已构建的页面，可以继续测试；也可另开终端运行 `bun run dev:webview` 启用热更新。
- Rosetta 检测导致 `build:webview` 失败：在本机普通终端运行构建，避免进程查询被沙箱拦截。
