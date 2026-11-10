# Java 接入：从日志平台导入 Function Call Bad Case 到 MongoDB

适用：Java 17+、Spring Boot 3.x、Spring Data MongoDB、MongoDB 同步驱动和 Jackson 2.x。

本文是独立的外部接入示例，不修改评测平台源码，不自动执行评测。数据合同依据当前 Cline 仓库 `apps/agent-eval` 的 MongoDB Schema、function-call 执行器和 Python 导入示例。

## 1. 接入目标与前提

日志平台选中一次模型请求及其对应的错误响应，选择评测模块，点击“导入 Bad case”，后端将日志转换成案例并写入 `agent_eval_cases`。

- 使用 `MongoTemplate` 获取数据库和会话，使用同步驱动的 `Filters`、`Updates` 和 `InsertOneResult` 完成写入。
- MongoDB 数据库由日志平台的 MongoTemplate 连接配置选择；必须与评测平台使用同一个数据库。集合名可在示例常量处调整。
- 数据库必须是支持事务的副本集或分片部署。
- 集合与最新 validator 由 DBA 提前准备，必须支持 `definition.badCase`、`definition.importSource` 和 function-call 历史。运行账号不需要建表、建索引或 `collMod` 权限。
- 运行账号需要数据库 `listCollections`、模块集合 `find/update`、案例集合 `find/insert` 权限。
- 目标模块必须已经在评测平台创建。使用 `GET /api/modules` 返回的真实字符串 ID，不使用模块名称，也不自动创建模块。

## 2. 原始请求格式

原始输入为日志平台记录的请求：

```json
{
  "headers": {
    "host": "localhost:8000",
    "content-type": "application/json",
    "authorization": "***REDACTED***",
    "x-session-id": "1793672075873_otva3",
    "x-message-id": "7810f591d93c422dad0671fb81e7657a"
  },
  "body": {
    "model": "pro",
    "max_tokens": 8192,
    "messages": [],
    "tools": [],
    "tool_choice": "auto",
    "stream": true,
    "stream_options": {"include_usage": true},
    "temperature": 0.8,
    "chat_template_kwargs": {"enable_thinking": false}
  }
}
```

这里的 `messages: []`、`tools: []` 表示省略的标准 OpenAI Chat Completions 内容，不代表按纯文本单轮处理。实际调用导入器时传入完整数组。

`messages` 可以包含 `system`、`developer`、`user`、带 `tool_calls` 的 `assistant`，以及带 `tool_call_id` 的 `tool` 消息。当前案例合同仅支持字符串正文，或工具调用 assistant 的 null/省略正文；多模态正文和额外协议字段需要单独适配，不会静默删除。

错误响应不在这个请求对象中：日志平台应另外传入同一次模型调用对应的原始错误响应、错误原因和目标模块 ID。请求头、请求正文不能代替错误响应。

## 3. 字段转换规则

| 来源 | MongoDB 字段 | 处理方式 |
|---|---|---|
| 目标模块字符串 ID | `moduleId` | 后台核对模块存在且未归档 |
| 案例名称 | `definition.id` | 模块内业务名称，不是 MongoDB `_id` |
| 固定模式 | `definition.replayMode` | `function-call` |
| 末尾 user 文本 | `definition.prompt` | 从历史移出，避免执行器再次追加时重复发送 |
| 其余原生 messages | `definition.functionCall.history` | 保留系统消息、工具调用和工具结果 |
| 外层历史 | `definition.history` | 固定为空数组 |
| `body.tools[].function.name` | `definition.functionCall.tools` | 转为内置工具名称列表，并比对参数 Schema |
| `body.tool_choice` | `definition.functionCall.toolChoice` | auto/required 或指定工具名称 |
| `body.model` | `defaults.modelId` | 保留实际模型名，如 pro |
| 实际模型服务地址 | `defaults.baseUrl` | 显式传入，不从 host 猜测 |
| 模型密钥的环境变量名 | `defaults.apiKeyEnv` | 只保存名称，不保存密钥值 |
| `x-session-id` | `definition.importSource.taskId` | 必须稳定 |
| `x-message-id` | `definition.importSource.turnId` | 必须唯一标识选中的一次模型调用 |
| 原始错误响应 | `definition.badCase.observedOutput` | 独立保存，不加入 prompt/history |
| 错误响应格式 | `definition.badCase.outputFormat` | text 或 json |

### 当前执行器的边界

1. 平台目前仅支持 `read_files`、`search_codebase`、`run_commands`、`fetch_web_content`、`editor`、`skills` 六种工具。回放会按工具名加载平台内置 Schema，不能将任意工具声明直接写入该字段。同名工具的参数 Schema 不一致也应拒绝导入。
2. 执行器固定在历史后追加非空 user prompt。若原请求以工具结果或 assistant 结尾，必须由用户明确提供续接文案；这会增加一条 user 消息，不能声称与原请求逐消息一致。需要完全还原这类请求时，应先扩展执行器，本文不修改执行器。
3. 回放是一次模型请求，不执行模型返回的工具调用。
4. `temperature`、`max_tokens`、`stream_options`、`chat_template_kwargs` 不由当前 function-call 执行器透传；回放使用 `stream: false`。因此本文实现案例合同兼容导入，不保证原 HTTP 请求逐参数一致。
5. `tool_choice: "none"` 和无工具请求不属于当前 function-call 案例合同。示例明确报错，不自动换成其他模式。

## 4. 依赖与工具 Schema

已有 Spring Boot 工程中加入以下依赖；版本由工程的 Spring Boot BOM 管理，不要混用不兼容的 MongoDB 驱动版本。

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-data-mongodb</artifactId>
</dependency>
<dependency>
    <groupId>com.fasterxml.jackson.core</groupId>
    <artifactId>jackson-databind</artifactId>
</dependency>
```

将当前评测平台对应版本的：

```text
apps/agent-eval/src/contracts/function-call-schemas.json
```

复制到日志平台工程的：

```text
src/main/resources/function-call-schemas.json
```

该文件必须来自可信的已部署评测平台版本，不能接受浏览器上传的“标准 Schema”。示例用它核对原请求的工具参数定义，避免同名不同义。工具 description/strict 等行为不会由当前平台原样回放，导入前应确认是否接受此差异。

## 5. 完整 Java Service 示例

保存为 `BadCaseImporter.java`，修改 package 和集合常量以适配工程。无需再拼接聊天中的旧版 single-turn 示例。

```java
package com.example.eval;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.mongodb.ClientSessionOptions;
import com.mongodb.MongoCommandException;
import com.mongodb.MongoException;
import com.mongodb.MongoWriteException;
import com.mongodb.ReadConcern;
import com.mongodb.ReadPreference;
import com.mongodb.TransactionOptions;
import com.mongodb.WriteConcern;
import com.mongodb.client.ClientSession;
import com.mongodb.client.MongoCollection;
import com.mongodb.client.MongoDatabase;
import com.mongodb.client.model.Collation;
import com.mongodb.client.model.Filters;
import com.mongodb.client.model.Updates;
import com.mongodb.client.result.InsertOneResult;
import org.bson.Document;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.stereotype.Service;

import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.TimeUnit;

@Service
public class BadCaseImporter {
    private static final String CASES = "agent_eval_cases";
    private static final String MODULES = "agent_eval_modules";
    private static final String PLATFORM = "internal-agent-logs";
    private static final UUID NAMESPACE =
            UUID.fromString("5542c067-e6a7-52a3-af06-cc65f944e6e4");
    private static final Set<String> TOOLS = Set.of(
            "read_files", "search_codebase", "run_commands",
            "fetch_web_content", "editor", "skills");
    private static final ObjectMapper JSON = new ObjectMapper()
            .enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);

    private final MongoTemplate template;
    private final JsonNode toolSchemas;

    public BadCaseImporter(MongoTemplate template) {
        this.template = template;
        try (InputStream in = getClass().getResourceAsStream(
                "/function-call-schemas.json")) {
            if (in == null) throw new IllegalStateException("缺少可信工具 Schema");
            toolSchemas = JSON.readTree(in);
            for (String tool : TOOLS) {
                if (!toolSchemas.has(tool)) {
                    throw new IllegalStateException("工具 Schema 不完整");
                }
            }
        } catch (Exception e) {
            throw new IllegalStateException("加载可信工具 Schema 失败");
        }
    }

    public record Request(
            String rawRequestJson, String moduleId, String caseName,
            String observedOutput, String outputFormat, String reason,
            String baseUrl, String apiKeyEnv, String continuationPrompt) {}

    public record Result(String status, String caseId, String message) {}

    public Result importBadCase(Request request) {
        Document candidate = buildDocument(request);
        String id = candidate.getString("_id");
        MongoDatabase db = template.getDb()
                .withReadPreference(ReadPreference.primary());
        MongoCollection<Document> cases = db.getCollection(CASES);
        MongoCollection<Document> modules = db.getCollection(MODULES);
        try {
            List<String> names = db.listCollectionNames().into(new ArrayList<>());
            if (!names.contains(CASES) || !names.contains(MODULES)) {
                return new Result("not-found", id, "请先由 DBA 准备案例和模块集合");
            }
            TransactionOptions options = TransactionOptions.builder()
                    .readConcern(ReadConcern.SNAPSHOT)
                    .writeConcern(WriteConcern.MAJORITY)
                    .readPreference(ReadPreference.primary())
                    .maxCommitTime(5, TimeUnit.SECONDS).build();
            try (ClientSession session = template.getMongoDatabaseFactory()
                    .getSession(ClientSessionOptions.builder().build())) {
                return session.withTransaction(() -> {
                    String moduleId = candidate.getString("moduleId");
                    Document module = modules.find(
                            session, Filters.eq("_id", moduleId)).first();
                    validateModule(module);
                    if (Boolean.TRUE.equals(module.get("archived"))) {
                        throw new Failure("conflict", "目标模块已归档");
                    }
                    // 与平台的模块归档/案例写入协议协调。
                    // 回调可能重试，禁止在此发送通知等外部副作用。
                    var touched = modules.updateOne(session,
                            Filters.and(Filters.eq("_id", moduleId),
                                    Filters.eq("archived", false),
                                    Filters.eq("writeVersion", module.get("writeVersion"))),
                            Updates.inc("writeVersion", 1));
                    if (touched.getModifiedCount() != 1) {
                        throw new Failure("conflict", "模块发生变化，请保留原身份重试");
                    }
                    Document existing = cases.find(
                            session, Filters.eq("_id", id)).first();
                    if (existing != null) {
                        if (sameContent(existing, candidate)) {
                            return new Result("unchanged", id, "该案例已导入");
                        }
                        throw new Failure("conflict", "同一来源案例内容变化或已归档，不覆盖");
                    }
                    String name = candidate.get("definition", Document.class)
                            .getString("id");
                    Document duplicate = cases.find(session, Filters.and(
                                    Filters.eq("moduleId", moduleId),
                                    Filters.eq("archived", false),
                                    Filters.eq("definition.id", name)))
                            .collation(Collation.builder().locale("simple").build())
                            .first();
                    if (duplicate != null) {
                        throw new Failure("conflict", "模块内已有同名案例");
                    }
                    InsertOneResult inserted = cases.insertOne(
                            session, new Document(candidate));
                    if (!inserted.wasAcknowledged()) {
                        throw new Failure("unknown", "写入未确认，请按案例 ID 核对");
                    }
                    return new Result("created", id, "导入成功");
                }, options); // 返回前会完成事务提交。
            }
        } catch (Failure e) {
            return new Result(e.status, id, e.getMessage());
        } catch (MongoWriteException e) {
            return mongoError(e, cases, candidate);
        } catch (MongoCommandException e) {
            return mongoError(e, cases, candidate);
        } catch (MongoException e) {
            return mongoError(e, cases, candidate);
        }
    }

    // 可独立调用做预校验：不会连接数据库，也不会证明远端写入权限有效。
    public Document buildDocument(Request r) {
        String moduleId = text(r.moduleId(), "moduleId");
        String name = text(r.caseName(), "caseName");
        String baseUrl = text(r.baseUrl(), "baseUrl");
        try {
            var uri = java.net.URI.create(baseUrl);
            if (!List.of("http", "https").contains(uri.getScheme())
                    || uri.getHost() == null || uri.getUserInfo() != null
                    || uri.getRawQuery() != null || uri.getRawFragment() != null) {
                throw new IllegalArgumentException();
            }
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("baseUrl 须为无凭据/查询/片段的 HTTP(S) 地址");
        }
        String keyEnv = text(r.apiKeyEnv(), "apiKeyEnv");
        if (!keyEnv.matches("[A-Za-z_][A-Za-z0-9_]*")) {
            throw new IllegalArgumentException("apiKeyEnv 必须为环境变量名");
        }
        String raw = bytes(r.rawRequestJson(), "rawRequestJson", 12 * 1024 * 1024);
        if (!parseJson(raw).isObject()) {
            throw new IllegalArgumentException("原始请求必须为 JSON 对象");
        }
        Document log;
        try { log = Document.parse(raw); }
        catch (RuntimeException e) {
            throw new IllegalArgumentException("原始请求无法解析为文档");
        }
        Document headers = object(log.get("headers"), "headers");
        Document body = object(log.get("body"), "body");
        String taskId = sourceText(header(headers, "x-session-id"), "sessionId");
        String turnId = sourceText(header(headers, "x-message-id"), "messageId");

        List<Document> history = new ArrayList<>();
        for (Object m : array(body.get("messages"), "messages")) {
            history.add(new Document(object(m, "message")));
        }
        if (history.isEmpty()) {
            throw new IllegalArgumentException("实际 messages 不能为空，请传入完整请求");
        }
        if (history.size() > 500) throw new IllegalArgumentException("消息超过 500 条");

        String prompt;
        Document last = history.get(history.size() - 1);
        if ("user".equals(last.get("role"))) {
            onlyKeys(last, Set.of("role", "content"), "末尾 user");
            prompt = text(last.get("content"), "末尾 user.content");
            history.remove(history.size() - 1);
        } else {
            prompt = text(r.continuationPrompt(), "该请求须明确提供续接文案");
        }
        validateHistory(history);
        bytes(prompt, "prompt", 1024 * 1024);
        if (jsonBytes(history).length > 1024 * 1024) {
            throw new IllegalArgumentException("原生历史超过 1 MiB");
        }

        List<String> selected = new ArrayList<>();
        for (Object value : array(body.get("tools"), "tools")) {
            Document tool = object(value, "tool");
            if (!"function".equals(tool.get("type"))) {
                throw new IllegalArgumentException("只支持 function 工具");
            }
            Document fn = object(tool.get("function"), "tool.function");
            String toolName = text(fn.get("name"), "工具名");
            if (!TOOLS.contains(toolName) || selected.contains(toolName)) {
                throw new IllegalArgumentException("工具不支持或名称重复");
            }
            JsonNode parameters = parseJson(new String(
                    jsonBytes(fn.get("parameters")), StandardCharsets.UTF_8));
            if (!toolSchemas.get(toolName).equals(parameters)) {
                throw new IllegalArgumentException("工具参数 Schema 与平台版本不一致：" + toolName);
            }
            selected.add(toolName);
        }
        if (selected.isEmpty()) throw new IllegalArgumentException("工具列表不能为空");

        Object rawChoice = body.getOrDefault("tool_choice", "auto");
        String choice;
        if (rawChoice instanceof String s) {
            if (!List.of("auto", "required").contains(s)) {
                throw new IllegalArgumentException("不支持该 tool_choice");
            }
            choice = s;
        } else {
            Document c = object(rawChoice, "tool_choice");
            if (!"function".equals(c.get("type"))) {
                throw new IllegalArgumentException("tool_choice.type 必须为 function");
            }
            choice = text(object(c.get("function"), "指定工具").get("name"), "工具名");
            if (!selected.contains(choice)) {
                throw new IllegalArgumentException("指定工具不在 tools 中");
            }
        }
        String observed = bytes(r.observedOutput(), "observedOutput", 1048576);
        String format = text(r.outputFormat(), "outputFormat");
        if (!List.of("text", "json").contains(format)) {
            throw new IllegalArgumentException("outputFormat 必须为 text/json");
        }
        if ("json".equals(format)) parseJson(observed);
        Document bad = new Document("observedOutput", observed)
                .append("outputFormat", format);
        if (r.reason() != null) bad.append("reason", bytes(r.reason(), "reason", 16384));
        Document definition = new Document("id", name)
                .append("replayMode", "function-call")
                .append("prompt", prompt).append("history", List.of())
                .append("functionCall", new Document("tools", selected)
                        .append("toolChoice", choice).append("history", history))
                .append("badCase", bad)
                .append("importSource", new Document("platform", PLATFORM)
                        .append("taskId", taskId).append("turnId", turnId));
        Document defaults = new Document("providerId", "openai-compatible")
                .append("modelId", text(body.get("model"), "model"))
                .append("baseUrl", baseUrl).append("apiKeyEnv", keyEnv)
                .append("timeoutMs", 300000).append("maxIterations", 10)
                .append("tools", "read-only");
        Date now = new Date();
        Document doc = new Document("_id", stableId(moduleId, taskId, turnId))
                .append("schemaVersion", 1).append("moduleId", moduleId)
                .append("revision", 1).append("archived", false)
                .append("createdAt", now).append("updatedAt", now)
                .append("definition", definition).append("defaults", defaults);
        // 按实际 BSON 大小检查，不用 JSON 长度代替 BSON 长度。
        var encoded = new org.bson.RawBsonDocument(doc, new org.bson.codecs.DocumentCodec());
        if (encoded.getByteBuffer().remaining() > 15 * 1024 * 1024) {
            throw new IllegalArgumentException("案例 BSON 文档超过 15 MiB");
        }
        return doc;
    }

    private static void validateHistory(List<Document> history) {
        Set<String> pending = new HashSet<>(), used = new HashSet<>();
        boolean leading = true;
        for (Document m : history) {
            onlyKeys(m, Set.of("role", "content", "name", "tool_calls", "tool_call_id"), "历史消息");
            String role = text(m.get("role"), "role");
            if (!Set.of("system", "developer", "user", "assistant", "tool").contains(role)) {
                throw new IllegalArgumentException("不支持的消息角色");
            }
            if (Set.of("system", "developer").contains(role)) {
                if (!leading) throw new IllegalArgumentException("系统消息只能位于历史前部");
            } else leading = false;
            if (!pending.isEmpty() && !"tool".equals(role)) {
                throw new IllegalArgumentException("历史缺少工具结果");
            }
            if (m.containsKey("name")) text(m.get("name"), "message.name");
            if (m.containsKey("content") && !("assistant".equals(role) && m.get("content") == null)) {
                if (!(m.get("content") instanceof String)) {
                    throw new IllegalArgumentException("历史正文只支持字符串");
                }
            }
            if ("tool".equals(role)) {
                if (!(m.get("content") instanceof String) || m.containsKey("tool_calls")
                        || !pending.remove(text(m.get("tool_call_id"), "tool_call_id"))) {
                    throw new IllegalArgumentException("工具结果缺少调用、重复或结构无效");
                }
                continue;
            }
            if (m.containsKey("tool_call_id")) {
                throw new IllegalArgumentException("只有 tool 消息可以有 tool_call_id");
            }
            if (m.containsKey("tool_calls")) {
                List<?> calls = array(m.get("tool_calls"), "tool_calls");
                if (!"assistant".equals(role) || calls.isEmpty()) {
                    throw new IllegalArgumentException("tool_calls 必须属于 assistant 且非空");
                }
                for (Object value : calls) {
                    Document call = object(value, "tool_call");
                    onlyKeys(call, Set.of("id", "type", "function"), "tool_call");
                    String id = text(call.get("id"), "调用 ID");
                    if (!used.add(id) || !"function".equals(call.get("type"))) {
                        throw new IllegalArgumentException("调用 ID 重复或非 function 类型");
                    }
                    Document fn = object(call.get("function"), "function");
                    onlyKeys(fn, Set.of("name", "arguments"), "function");
                    text(fn.get("name"), "function.name");
                    JsonNode args = parseJson(text(fn.get("arguments"), "arguments"));
                    if (!args.isObject()) throw new IllegalArgumentException("工具参数必须为 JSON 对象");
                    pending.add(id);
                }
            } else text(m.get("content"), "message.content");
        }
        if (!pending.isEmpty()) throw new IllegalArgumentException("历史结尾缺少工具结果");
    }

    private static void validateModule(Document m) {
        if (m == null) throw new Failure("not-found", "目标模块不存在");
        Object version = m.get("writeVersion");
        if (!(m.get("archived") instanceof Boolean)
                || !(version instanceof Number n)
                || !Double.isFinite(n.doubleValue()) || n.doubleValue() < 1
                || n.doubleValue() >= 9007199254740991d
                || n.doubleValue() != Math.rint(n.doubleValue())
                || !(m.get("createdAt") instanceof Date)
                || !(m.get("name") instanceof String name) || name.isBlank()
                || name.length() > 80
                || !name.trim().toLowerCase(Locale.ROOT).equals(m.get("nameKey"))) {
            throw new Failure("invalid-module", "模块结构不符合平台合同");
        }
        if (m.containsKey("tags")) {
            Object tags = m.get("tags");
            if (!(tags instanceof List<?> list) || list.size() > 20
                    || list.stream().anyMatch(v -> !(v instanceof String s) || s.isBlank())) {
                throw new Failure("invalid-module", "模块标签结构不符合平台合同");
            }
        }
    }

    private static Result mongoError(MongoException e,
                                    MongoCollection<Document> cases, Document doc) {
        String id = doc.getString("_id");
        if (e.hasErrorLabel("UnknownTransactionCommitResult")) {
            try {
                Document existing = cases.withReadConcern(ReadConcern.MAJORITY)
                        .withReadPreference(ReadPreference.primary())
                        .find(Filters.eq("_id", id)).first();
                if (existing != null && sameContent(existing, doc)) {
                    return new Result("confirmed", id, "已核对到相同案例");
                }
            } catch (MongoException ignored) { }
            return new Result("unknown", id, "提交结果未知，保留原身份并按案例 ID 核对");
        }
        String status = switch (e.getCode()) {
            case 13 -> "unauthorized";
            case 121 -> "validation-failed";
            case 11000 -> "conflict";
            case 20, 303 -> "transactions-unsupported";
            default -> "database-error";
        };
        // 不返回原始异常、失败文档或连接串。
        return new Result(status, id, "数据库操作未成功确认，错误码：" + e.getCode());
    }

    private static boolean sameContent(Document a, Document b) {
        if (!Boolean.FALSE.equals(a.get("archived"))) return false;
        return List.of("schemaVersion", "moduleId", "definition", "defaults")
                .stream().allMatch(k -> Objects.equals(a.get(k), b.get(k)));
    }

    private static String stableId(String moduleId, String taskId, String turnId) {
        try {
            byte[] identity = jsonBytes(List.of(
                    moduleId, PLATFORM, taskId, turnId, "bad-case"));
            MessageDigest digest = MessageDigest.getInstance("SHA-1");
            digest.update(ByteBuffer.allocate(16)
                    .putLong(NAMESPACE.getMostSignificantBits())
                    .putLong(NAMESPACE.getLeastSignificantBits()).array());
            byte[] hash = digest.digest(identity);
            hash[6] = (byte) ((hash[6] & 0x0f) | 0x50);
            hash[8] = (byte) ((hash[8] & 0x3f) | 0x80);
            ByteBuffer bytes = ByteBuffer.wrap(hash);
            return new UUID(bytes.getLong(), bytes.getLong()).toString();
        } catch (Exception e) { throw new IllegalStateException("生成案例身份失败"); }
    }

    private static Object header(Document headers, String name) {
        Object value = null;
        boolean found = false;
        for (String key : headers.keySet()) {
            if (key.equalsIgnoreCase(name)) {
                if (found) throw new IllegalArgumentException("来源请求头重复");
                found = true;
                value = headers.get(key);
            }
        }
        return value;
    }
    private static String text(Object value, String field) {
        if (!(value instanceof String s) || s.isBlank()) {
            throw new IllegalArgumentException(field + " 必须为非空字符串");
        }
        return s; // 不 trim 正文，不改变原始内容。
    }
    private static String bytes(Object v, String field, int max) {
        String s = text(v, field);
        if (s.getBytes(StandardCharsets.UTF_8).length > max) {
            throw new IllegalArgumentException(field + " 超过 UTF-8 字节上限");
        }
        return s;
    }
    private static String sourceText(Object v, String field) {
        String s = text(v, field);
        if (s.codePointCount(0, s.length()) > 256) {
            throw new IllegalArgumentException(field + " 超过 256 字符");
        }
        return s;
    }
    private static Document object(Object v, String field) {
        if (!(v instanceof Document d)) throw new IllegalArgumentException(field + " 须为对象");
        return d;
    }
    private static List<?> array(Object v, String field) {
        if (!(v instanceof List<?> list)) throw new IllegalArgumentException(field + " 须为数组");
        return list;
    }
    private static void onlyKeys(Document d, Set<String> allowed, String field) {
        if (!allowed.containsAll(d.keySet())) {
            throw new IllegalArgumentException(field + " 包含暂不支持的字段");
        }
    }
    private static JsonNode parseJson(String s) {
        try {
            JsonNode node = JSON.readTree(s);
            if (node == null) throw new IllegalArgumentException();
            return node;
        } catch (Exception e) { throw new IllegalArgumentException("JSON 格式无效"); }
    }
    private static byte[] jsonBytes(Object value) {
        try { return JSON.writeValueAsBytes(value); }
        catch (Exception e) { throw new IllegalArgumentException("JSON 编码失败"); }
    }
    private static final class Failure extends RuntimeException {
        final String status;
        Failure(String status, String message) { super(message); this.status = status; }
    }
}
```

## 6. 在日志平台后端调用

```java
var request = new BadCaseImporter.Request(
        rawRequestJson,       // 选中调用的完整 headers/body，含真实 messages/tools
        targetModuleId,       // 目标模块真实字符串 ID
        "数据分析-工具调用错误案例",
        originalBadResponse,  // 该次模型调用对应的错误响应，不能用请求体代替
        "json",               // 完整 JSON 响应用 json；SSE 原文等用 text
        "说明本次调用不符合预期的原因",
        "https://model-gateway.example/v1",
        "EVAL_API_KEY",       // 在执行评测的服务端配置实际值
        null                  // 末尾是 user 时无需续接文案
);

// 可选：先构造校验，尚不写库。
// Document preview = badCaseImporter.buildDocument(request);

BadCaseImporter.Result result = badCaseImporter.importBadCase(request);
```

如果原始请求以工具结果结尾，最后一个参数传入用户明确填写的续接文案，例如“根据以上结果完成分析”。这会改变原请求消息序列，接口和页面应明确展示，不能自动填充后声称精确复现。

如果日志里的 message ID 会在不同模型调用之间复用，应先将 `turnId` 的来源改为平台真实、稳定且唯一的模型调用记录 ID；不能用导入时间或每次随机生成的 ID。

接口层将参数校验的 `IllegalArgumentException` 转为用户可读的 400 响应。未预期的系统异常应使用统一异常处理；不要将原始日志、连接串或数据库异常全文返回前端。

## 7. 状态和前端行为

| status | 含义 | 建议展示 |
|---|---|---|
| created | 事务已提交，新案例已创建 | 导入成功，返回 caseId |
| unchanged | 同一来源、相同内容已存在 | 已导入，不重复新增 |
| confirmed | 提交曾不确定，多数派读核对到相同内容 | 已确认导入 |
| conflict | 同名、来源内容变化、目标归档等 | 提示用户处理，不覆盖 |
| not-found | 集合或目标模块不存在 | 核对目标配置 |
| invalid-module | 模块结构不符合平台合同 | 由管理员核对模块数据 |
| unauthorized | 数据库授权不足 | 由管理员核对权限 |
| validation-failed | MongoDB validator 拒绝 | 核对最新 cases 校验规则及字段类型 |
| transactions-unsupported | 部署不支持所需事务 | 使用支持事务的部署 |
| database-error / unknown | 尚未确认成功 | 保留来源身份和 caseId，核对或重试 |

按钮点击后在请求期间禁用重复提交；网络断开后可以用相同请求重试，但必须保持 moduleId、platform、taskId、turnId 和案例内容不变。名称修改、错误输出修改也会触发 conflict，不会覆盖旧记录。

去重身份采用 UUIDv5，命名空间和身份数组与仓库 Python 示例相同。createdAt/updatedAt 不参与内容比对；已编辑或归档案例不自动覆盖。所有外部写入方都应遵循模块 writeVersion 协调协议，绕过该协议的写入不能获得相同并发保证。

## 8. 写入后的文档形状

下面是结构说明，省略部分业务值；实际 Java 写入的 createdAt/updatedAt 是 `java.util.Date` 对应的 BSON Date，而不是日期字符串或字面量 `$date` 对象。

```json
{
  "_id": "稳定生成的字符串UUID",
  "schemaVersion": 1,
  "moduleId": "真实模块字符串ID",
  "revision": 1,
  "archived": false,
  "createdAt": {"$date": "2026-11-03T00:00:00.000Z"},
  "updatedAt": {"$date": "2026-11-03T00:00:00.000Z"},
  "definition": {
    "id": "数据分析-工具调用错误案例",
    "replayMode": "function-call",
    "prompt": "本轮实际用户输入",
    "history": [],
    "functionCall": {
      "tools": ["read_files", "editor"],
      "toolChoice": "auto",
      "history": [
        {"role": "user", "content": "读取 demo.py"},
        {
          "role": "assistant",
          "content": null,
          "tool_calls": [{
            "id": "call_1",
            "type": "function",
            "function": {
              "name": "read_files",
              "arguments": "{\"paths\":[\"demo.py\"]}"
            }
          }]
        },
        {"role": "tool", "tool_call_id": "call_1", "content": "print('hello')"}
      ]
    },
    "badCase": {
      "observedOutput": "{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"错误回答\"}}]}",
      "outputFormat": "json",
      "reason": "工具调用或回答未达到预期"
    },
    "importSource": {
      "platform": "internal-agent-logs",
      "taskId": "1793672075873_otva3",
      "turnId": "7810f591d93c422dad0671fb81e7657a"
    }
  },
  "defaults": {
    "providerId": "openai-compatible",
    "modelId": "pro",
    "baseUrl": "https://model-gateway.example/v1",
    "apiKeyEnv": "EVAL_API_KEY",
    "timeoutMs": 300000,
    "maxIterations": 10,
    "tools": "read-only"
  }
}
```

`defaults.tools` 和 maxIterations 是一般案例默认配置，不决定 function-call 的工具声明；该模式由 `definition.functionCall.tools` 指定工具，并只进行一次模型请求。错误输出仅供详情展示，不自动变成 Judge 参考答案或让案例自动判失败。

## 9. 接入验收

在隔离测试数据库中完成以下验证，再接入正式环境：

1. 带完整 user/assistant/tool 历史的请求可写入，评测平台刷新后能够读取案例。
2. 回放消息没有重复的末尾 user；错误响应没有出现在模型输入中。
3. 并行 tool_calls 与对应多个 tool 结果可通过；缺结果、重复 ID、重复结果、非法参数 JSON 被拒绝。
4. 不支持的工具、同名但不同参数 Schema、多模态消息和未知消息字段明确报错。
5. 连续点击和并发导入同一来源只保留一个案例；更改内容或导入同名案例返回 conflict。
6. 目标模块不存在或归档时不新增案例；validator 拒绝写入时模块 writeVersion 更新随事务回滚。
7. 检查实际保存的是 BSON Date、字符串 UUID，且没有保存 authorization 或模型密钥值。
8. 原请求以工具结果结尾时必须显式提供续接文案，并展示新增 user 消息的事实。
9. 不确定提交不误报成功；保留原身份，用相同 caseId 核对或重试。

## 10. 验证范围

已检查 Markdown 代码围栏和 JSON 示例语法，并用当前项目的 `parseEvalSuite` 成功解析第 8 节案例示例。

未连接内网 MongoDB，也未在目标 Spring Boot 工程编译或执行事务集成测试。依赖版本、权限、可信工具 Schema、实际日志格式和评测平台读取行为需在接入工程中验证。
