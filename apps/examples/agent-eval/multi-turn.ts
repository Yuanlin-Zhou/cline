import { ClineCore } from "@cline/sdk";

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error("请设置 DEEPSEEK_API_KEY");

const prompts = [
  "项目名称是星河，使用 Bun 管理依赖。请记住这些信息。",
  "现在新增要求：后端使用 TypeScript。请汇总目前的技术要求。",
  "根据之前的要求，告诉我项目名称，以及安装依赖的命令。",
];

const cline = await ClineCore.create({
  clientName: "multi-turn-eval",
  backendMode: "local",
});

let sessionId: string | undefined;

try {
  // 创建空会话。interactive: true 让每轮结束后会话继续保留，
  // 并不要求打开终端交互界面。
  const session = await cline.start({
    interactive: true,
    config: {
      providerId: "openai-compatible",
      modelId: "deepseek-v4-flash",
      baseUrl: "https://api.deepseek.com",
      apiKey,
      cwd: process.cwd(),
      mode: "act",
      systemPrompt: "请用中文回答，遵守对话中已经确定的要求。",
      maxIterations: 6,
      enableTools: false,
      enableSpawnAgent: false,
      enableAgentTeams: false,
      disableMcpSettingsTools: true,
    },
    toolPolicies: {
      "*": { enabled: false },
    },
  });

  sessionId = session.sessionId;
  const turns = [];

  for (const [index, prompt] of prompts.entries()) {
    // 必须 await：上一轮完成后才开始下一轮。
    const result = await cline.send({ sessionId, prompt });

    if (!result) {
      throw new Error(`第 ${index + 1} 轮没有返回结果`);
    }

    turns.push({
      turn: index + 1,
      prompt,
      text: result.text,
      finishReason: result.finishReason,
      usage: result.usage,
      durationMs: result.durationMs,
      toolCalls: result.toolCalls,
    });

    console.error(`第 ${index + 1} 轮完成：${result.finishReason}`);

    // 异常终止时不继续后续轮次。
    if (result.finishReason !== "completed") break;
  }

  console.log(JSON.stringify({ sessionId, turns }, null, 2));
} finally {
  try {
    if (sessionId) await cline.stop(sessionId);
  } finally {
    await cline.dispose();
  }
}
