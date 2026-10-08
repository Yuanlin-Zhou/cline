# Agent Evaluation Platform V1.1 重构实施 Spec

> 文档类型：Implementation Spec
> 目标读者：直接修改现有仓库的 Coding Agent
> 目标版本：V1 → V1.1
> 技术栈：Node.js + TypeScript
> 核心目标：在不破坏现有 V1 功能的前提下，将当前评测系统重构为 `Task → Trial → Agent/Environment → Trajectory/Artifact → Verifier → Result` 的通用 Evaluation Runtime，并引入 Harbor-compatible Task Package。

---

# 0. 执行要求

当前仓库已经存在一套可运行的 Agent Evaluation System。

已经实现：

```text
1. Benchmark / Dataset
- Module / Tag
- JSON / JSONL 导入
- Case CRUD
- Copy / Archive / Delete
- Revision

2. Evaluation Runtime
- Single-turn Replay
- Full-task Replay
- ClineCore Session
- Model Config
- Tool Permission
- Iteration / Timeout
- Batch
- Concurrency
- Cancel
- Repeat

3. Environment
- 独立 Process
- 独立 Session Directory
- 独立 Workspace
- Fixture Copy
- Empty Workspace
- Baseline Snapshot
- Final File Snapshot

4. Observability
- Final Response
- Session ID
- Token Usage
- Latency
- Tool Summary
- Diagnostic Trajectory
- Event Log
- File Diff
- Evidence Reference

5. Verification
- Text Assertion
- Finish Reason
- File Rule
- Text Rule
- JSON Rule
- File Unchanged
- Command Verifier
- Script Verifier
- Required / Optional Criteria
- Per-rule Evidence

6. Experiment
- Batch History
- Case History
- Snapshot Re-run
- 1–100 Repetitions
- Pass Rate
- Output Consistency
- JSON / CSV / Markdown Report
```

本次任务不是重新开发系统。

必须保留：

```text
现有 Case 数据兼容能力
现有 UI 行为
现有 Replay 能力
现有 ClineCore 行为
现有 Batch / Repeat 能力
现有 Verification 能力
现有历史结果查看能力
现有 Report Export
```

本次目标：

```text
重构 Core Domain
+
标准化 Task Format
+
解耦 Runtime
+
建立稳定 Extension Points
```

禁止：

```text
大规模重写业务逻辑

删除旧 Case 格式支持

重新实现 ClineCore

引入 Docker Sandbox

引入 Remote Worker

实现 LLM Judge

实现独立 Verifier Container

大规模重新设计前端
```

---

# 1. 最终目标架构

```text
Dataset
   │
   ▼
Task Package
   │
   ▼
TaskLoader
   │
   ▼
TaskDefinition
   │
   ▼
TrialBuilder
   │
   ▼
Trial
   │
   ├──── AgentAdapter
   ├──── ModelConfig
   └──── EnvironmentProvider
                  │
                  ▼
             Agent Runtime
                  │
                  ▼
           TrajectoryRecorder
             ┌────┴────┐
             ▼         ▼
        Trajectory   Artifacts
             │         │
             └────┬────┘
                  ▼
               Evidence
                  │
                  ▼
          VerifierPipeline
                  │
                  ▼
             TrialResult
                  │
                  ▼
          Job / Experiment
```

---

# 2. 重构原则

## 2.1 不推倒 V1

优先：

```text
Wrap
Adapt
Extract
Normalize
```

而不是：

```text
Rewrite
```

---

## 2.2 Harbor-compatible，不依赖 Harbor

内部 Runtime 不依赖 Harbor。

目标只是让 Task Package 尽可能兼容：

```text
task.toml
instruction.md
environment/
tests/
solution/
```

内部额外能力放：

```text
context/
metadata.devagent
```

---

## 2.3 五个核心边界

必须保证：

```text
Task ≠ Trial

Agent ≠ Evaluation Runtime

Environment ≠ Agent

Trajectory ≠ Trusted Evidence

Execution ≠ Scoring
```

这五点优先级高于具体目录结构。

---

# 3. Phase 0：扫描现有代码

开始修改前，先完整扫描仓库。

必须定位：

```text
Case 数据模型

JSON / JSONL Import

Case CRUD

Revision

Single-turn Runner

Full-task Runner

ClineCore 调用入口

Workspace 初始化

Fixture Copy

Snapshot

File Diff

Trajectory / Event Log

Verifier

Batch

Repeat

Result Model

Report Export
```

生成：

```text
docs/refactor/v1_1-current-state.md
```

内容：

```markdown
| Capability | Current Module | Main Symbol | Target | Action |
|---|---|---|---|---|
| Case Load | ... | ... | TaskLoader | refactor |
| Cline Run | ... | ... | ClineCoreAdapter | wrap |
| Workspace | ... | ... | LocalWorkspaceProvider | wrap |
```

要求：

> 不允许根据本 Spec 猜现有文件名。先读代码，再确定修改方案。

完成 Phase 0 后再开始代码修改。

---

# 4. 推荐代码结构

不要机械复制目录。

在现有结构基础上逐渐向以下职责划分靠拢：

```text
src/
├── core/
│   ├── task.ts
│   ├── trial.ts
│   ├── job.ts
│   ├── result.ts
│   ├── evidence.ts
│   └── artifact.ts
│
├── loaders/
│   ├── task-loader.ts
│   └── legacy-case-adapter.ts
│
├── agents/
│   ├── agent-adapter.ts
│   └── cline-core-adapter.ts
│
├── environments/
│   ├── environment-provider.ts
│   └── local-workspace-provider.ts
│
├── trajectory/
│   ├── types.ts
│   ├── recorder.ts
│   └── normalizer.ts
│
├── verifiers/
│   ├── verifier.ts
│   ├── rule-verifier.ts
│   ├── command-verifier.ts
│   ├── script-verifier.ts
│   └── verifier-pipeline.ts
│
├── runtime/
│   ├── trial-builder.ts
│   ├── trial-runner.ts
│   └── job-runner.ts
│
├── storage/
│   ├── task-store.ts
│   └── result-store.ts
│
└── services/
    ├── case-service.ts
    ├── experiment-service.ts
    └── report-service.ts
```

如果已有同类模块：

```text
优先复用
```

禁止为满足目录形式创建重复实现。

---

# 5. Phase 1：建立 Core Domain Model

这一阶段：

```text
只增加类型和基础工具
```

不要改变现有 Runtime 行为。

---

# 5.1 TaskDefinition

```ts
export type TaskType = "single_turn" | "full_task";

export interface TaskDefinition {
  id: string;
  version: string;

  name: string;
  description?: string;

  instruction: string;

  taskType: TaskType;

  module?: string;
  tags: string[];

  context?: TaskContext;

  environment: EnvironmentConfig;
  verification: VerificationConfig;

  metadata: Record<string, unknown>;

  sourcePath?: string;
}
```

---

# 5.2 TaskContext

```ts
export interface TaskContext {
  messages: ConversationMessage[];
  metadata: Record<string, unknown>;
}
```

不要直接使用：

```ts
any[]
```

如果项目已经存在 Message 类型：

```text
优先复用已有类型
```

否则定义最小兼容类型。

---

# 5.3 ModelConfig

```ts
export interface ModelConfig {
  provider?: string;

  model: string;

  endpoint?: string;

  temperature?: number;

  maxTokens?: number;

  extra: Record<string, unknown>;

  configHash?: string;
}
```

需要提供：

```ts
export function computeModelConfigHash(
  config: ModelConfig,
): string;
```

计算 Hash 前必须过滤：

```text
apiKey
api_key
token
accessToken
authorization
password
secret
```

等敏感字段。

Hash 必须：

```text
相同配置 → 相同 Hash
```

不受对象字段 insertion order 影响。

---

# 5.4 AgentConfig

```ts
export interface AgentConfig {
  name: string;

  version?: string;

  gitCommit?: string;

  toolPermissions: Record<string, unknown>;

  maxIterations?: number;

  timeoutSec?: number;

  extra: Record<string, unknown>;
}
```

现有：

```text
Tool Permission
Iteration
Timeout
```

逐步映射到 AgentConfig。

---

# 5.5 RuntimeConfig

```ts
export interface RuntimeConfig {
  concurrency: number;

  cancellationEnabled: boolean;

  extra: Record<string, unknown>;
}
```

不要把：

```text
attemptCount
```

放进 RuntimeConfig。

重复运行通过：

```text
多个 Trial
```

表达。

---

# 5.6 EnvironmentConfig

```ts
export type WorkspaceMode = "fixture" | "empty";

export interface EnvironmentConfig {
  provider: string;

  workspaceMode: WorkspaceMode;

  fixturePath?: string;

  timeoutSec?: number;

  extra: Record<string, unknown>;
}
```

当前：

```text
provider = local_workspace
```

---

# 5.7 VerificationConfig

根据已有 Rule Model 设计，不要重新创建第二套 Rule Schema。

建议包装：

```ts
export interface VerificationConfig {
  rules: VerificationRuleConfig[];

  commandVerifiers?: CommandVerifierConfig[];

  scriptVerifiers?: ScriptVerifierConfig[];

  metadata: Record<string, unknown>;
}
```

其中已有 Rule 类型应尽量直接复用。

---

# 5.8 Trial

```ts
export interface Trial {
  id: string;

  task: TaskDefinition;

  agent: AgentConfig;

  model: ModelConfig;

  environment: EnvironmentConfig;

  runtime: RuntimeConfig;

  attempt: number;

  createdAt: string;
}
```

核心要求：

```text
TaskDefinition 不保存 TrialResult

Trial 不修改 TaskDefinition

一个 Task 可以创建 N 个 Trial
```

---

# 5.9 Job / Experiment

```ts
export interface Job {
  id: string;

  name?: string;

  trials: Trial[];

  createdAt: string;

  metadata: Record<string, unknown>;
}
```

现有：

```text
Batch
```

逐渐映射为 Job。

UI 可以继续叫：

```text
Batch
Experiment
```

不强制修改现有文案。

---

# 5.10 Artifact

```ts
export type ArtifactType =
  | "file_diff"
  | "workspace_snapshot"
  | "generated_file"
  | "patch"
  | "log"
  | "other";

export interface Artifact {
  type: ArtifactType;

  name: string;

  path?: string;

  metadata: Record<string, unknown>;
}
```

---

# 5.11 Evidence

```ts
export enum EvidenceTrustLevel {
  Diagnostic = "diagnostic",

  RuntimeObserved = "runtime_observed",

  ArtifactObserved = "artifact_observed",

  VerifierObserved = "verifier_observed",

  AuditObserved = "audit_observed",
}
```

```ts
export interface Evidence {
  type: string;

  source: string;

  trustLevel: EvidenceTrustLevel;

  payload: Record<string, unknown>;
}
```

---

# 5.12 RuleStatus

```ts
export enum RuleStatus {
  Pass = "pass",

  Fail = "fail",

  Unsupported = "unsupported",

  Error = "error",

  Skipped = "skipped",
}
```

以后不得单纯使用：

```ts
boolean
```

表达 Verification 完整状态。

---

# 5.13 CriterionResult

```ts
export interface CriterionResult {
  id: string;

  required: boolean;

  status: RuleStatus;

  evidence: Evidence[];

  message?: string;
}
```

---

# 5.14 VerifierResult

```ts
export type VerificationStatus =
  | "completed"
  | "unsupported"
  | "error";

export interface VerifierResult {
  status: VerificationStatus;

  passed: boolean | null;

  criteria: CriterionResult[];

  metrics: Record<string, number>;

  error?: string;
}
```

如果：

```text
required rule = unsupported
```

不得：

```ts
passed = true;
```

应使用：

```ts
passed = null;
status = "unsupported";
```

---

# 5.15 TrialResult

```ts
export interface TrialResult {
  schemaVersion: string;

  trialId: string;

  status: TrialStatus;

  taskId: string;
  taskVersion: string;

  agentName: string;
  agentVersion?: string;
  agentGitCommit?: string;

  modelName: string;
  modelConfigHash?: string;

  attempt: number;

  sessionId?: string;

  finalAnswer?: string;

  usage: Record<string, unknown>;

  timing: Record<string, unknown>;

  trajectoryPath?: string;

  artifacts: Artifact[];

  verification?: VerifierResult;

  errors: TrialError[];

  createdAt: string;
  completedAt?: string;
}
```

---

# 5.16 Trial Status

```ts
export type TrialStatus =
  | "pending"
  | "preparing"
  | "running"
  | "verifying"
  | "completed"
  | "cancelled"
  | "error";
```

---

# 5.17 Phase 1 测试

使用项目当前的测试框架。

优先：

```text
已有 Vitest → 使用 Vitest

已有 Jest → 使用 Jest
```

不要为了此次重构更换 Test Framework。

至少测试：

```text
TaskDefinition serialization

Trial serialization

ModelConfig stable hash

Sensitive fields redaction

EvidenceTrustLevel

RuleStatus

TrialResult serialization
```

Phase 1 完成时：

```text
现有系统行为不能发生改变
```

---

# 6. Phase 2：Harbor-compatible Task Package

新 Case 使用标准目录：

```text
cases/
└── <module>/
    └── <task-id>/
        ├── task.toml
        ├── instruction.md
        │
        ├── context/
        │   ├── messages.json
        │   └── metadata.json
        │
        ├── environment/
        │   └── fixture/
        │
        ├── tests/
        │   ├── assertions.yaml
        │   ├── test.sh
        │   └── verifier.ts
        │
        └── solution/
            └── solve.sh
```

只有：

```text
task.toml
instruction.md
```

必须存在。

其他全部可选。

---

# 6.1 task.toml

建议：

```toml
schema_version = "1.0"

[task]
id = "web_fetch_invalid_arguments"
name = "Web Fetch Invalid Arguments"
version = "1.0.0"
description = "..."
keywords = ["tool-call", "web-fetch"]

[agent]
timeout_sec = 120

[verifier]
timeout_sec = 60
environment_mode = "shared"

[metadata.devagent]
task_type = "single_turn"
module = "tool_call"

context_file = "context/messages.json"

workspace_mode = "fixture"
fixture_path = "environment/fixture"
```

---

# 6.2 TOML Parser

使用项目已有依赖优先。

如果项目没有 TOML parser：

```text
选择维护正常、Node/TS 兼容的 TOML Parser
```

封装：

```ts
interface TaskToml {
  schema_version: string;

  task: {
    id: string;
    name: string;
    version: string;
    description?: string;
    keywords?: string[];
  };

  agent?: {
    timeout_sec?: number;
  };

  verifier?: {
    timeout_sec?: number;
    environment_mode?: string;
  };

  metadata?: {
    devagent?: Record<string, unknown>;
  };
}
```

不要让 TOML snake_case 直接污染内部 Domain Model。

Loader 中完成：

```text
snake_case → camelCase
```

---

# 6.3 TaskLoader

实现：

```ts
export interface TaskLoader {
  load(taskPath: string): Promise<TaskDefinition>;

  validate(taskPath: string): Promise<ValidationResult>;
}
```

推荐实现：

```ts
export class FileSystemTaskLoader implements TaskLoader {
  async load(
    taskPath: string,
  ): Promise<TaskDefinition> {
    // ...
  }

  async validate(
    taskPath: string,
  ): Promise<ValidationResult> {
    // ...
  }
}
```

负责：

```text
读取 task.toml

读取 instruction.md

读取 context/messages.json

解析 EnvironmentConfig

解析 VerificationConfig

normalize metadata
```

不负责：

```text
创建 Workspace

执行 Agent

运行 Verifier
```

---

# 6.4 Task Validation

至少检查：

```text
task.id 非空

task.name 非空

task.version 非空

instruction.md 存在

task_type 为 single_turn/full_task

context_file 配置后必须存在

fixture_path 配置后必须存在

JSON 文件可以解析

YAML 文件可以解析
```

---

# 6.5 Validation Model

```ts
export type ValidationIssueLevel =
  | "error"
  | "warning";

export interface ValidationIssue {
  level: ValidationIssueLevel;

  code: string;

  message: string;

  path?: string;
}
```

```ts
export interface ValidationResult {
  valid: boolean;

  issues: ValidationIssue[];
}
```

---

# 6.6 assertions.yaml

例如：

```yaml
version: 1

criteria:
  - id: final_answer_contains
    type: text_contains
    required: true

    target:
      source: final_answer

    expected:
      text: "完成"

  - id: output_exists
    type: file_exists
    required: true

    target:
      path: output/result.json
```

不要重新开发 Rule Engine。

实现：

```text
assertions.yaml
       ↓
parser / adapter
       ↓
当前已有 Verification Rules
```

---

# 6.7 LegacyCaseAdapter

实现：

```ts
export interface LegacyCaseAdapter {
  convert(
    legacyCase: LegacyCase,
  ): TaskDefinition;
}
```

或者根据现有结构：

```ts
export class DefaultLegacyCaseAdapter
  implements LegacyCaseAdapter {
  convert(
    legacyCase: LegacyCase,
  ): TaskDefinition {
    // ...
  }
}
```

必须覆盖：

```text
Prompt

Previous Messages

Module

Tags

Revision

Fixture

Workspace Mode

Rules

Timeout

Tool Permission
```

无法映射的旧字段放：

```ts
metadata: {
  legacy: {
    // ...
  }
}
```

禁止静默丢失。

---

# 6.8 Runtime 输入统一

重构后：

```text
Task Package
   ↓
TaskLoader

Legacy Case
   ↓
LegacyCaseAdapter

两者
   ↓
TaskDefinition
```

从此以后：

```text
Runtime
```

只能接收：

```ts
TaskDefinition
```

不能直接依赖：

```ts
LegacyCase
```

---

# 6.9 Phase 2 Fixtures

建议：

```text
test-fixtures/tasks/
```

或者遵循当前测试目录规范。

至少包含：

```text
single-turn-minimal

single-turn-with-context

full-task-empty-workspace

full-task-fixture

task-with-assertions
```

测试：

```text
load

validation

normalization

legacy parity
```

---

# 7. Phase 3：Trial / Job

---

# 7.1 TrialBuilder

```ts
export interface TrialBuildInput {
  task: TaskDefinition;

  agent: AgentConfig;

  model: ModelConfig;

  environment: EnvironmentConfig;

  runtime: RuntimeConfig;

  attempt: number;
}
```

```ts
export class TrialBuilder {
  build(
    input: TrialBuildInput,
  ): Trial {
    // ...
  }
}
```

Trial ID：

```text
使用 UUID
```

可以使用项目已有 UUID 能力。

如果没有：

```text
优先 Node crypto.randomUUID()
```

不要新增无必要依赖。

---

# 7.2 Repeat

当前：

```text
repeatCount = N
```

应转换为：

```text
N 个 Trial
```

例如：

```text
repeatCount = 3
```

产生：

```text
Trial attempt=1

Trial attempt=2

Trial attempt=3
```

禁止：

```text
一个 Trial 内循环执行三次
```

---

# 7.3 Batch

当前 Batch 映射成：

```text
Job
└── Trial[]
```

例如：

```text
10 Cases
×
2 Models
×
3 Attempts

=

60 Trials
```

---

# 7.4 Trial Snapshot

Trial 创建后必须保存快照：

```text
TaskDefinition

AgentConfig

ModelConfig

EnvironmentConfig

RuntimeConfig
```

Historical Re-run：

```text
必须从 Trial Snapshot 恢复
```

不能读取：

```text
当前最新 Case
```

代替历史配置。

---

# 7.5 Deep Copy / Immutability

避免后续修改：

```text
TaskDefinition
```

影响已经创建的 Trial。

可以：

```text
创建 Trial 时深拷贝 snapshot
```

或者使用：

```text
immutable/frozen data
```

具体方式根据现有架构决定。

但必须保证：

> Trial 建立以后，原 Case 后续编辑不能改变该 Trial 的历史输入。

---

# 7.6 Phase 3 验收

保持：

```text
单 Case 单次运行

单 Case 100 次运行

多个 Cases Batch

Concurrency

Cancel

历史 Snapshot Re-run
```

行为可用。

---

# 8. Phase 4：AgentAdapter

定义：

```ts
export interface AgentAdapter {
  setup(
    trial: Trial,
    environment: EvaluationEnvironment,
  ): Promise<void>;

  run(
    trial: Trial,
    environment: EvaluationEnvironment,
  ): Promise<AgentRunResult>;

  cleanup(): Promise<void>;
}
```

---

# 8.1 AgentRunResult

```ts
export interface AgentRunResult {
  sessionId?: string;

  finalAnswer?: string;

  finishReason?: string;

  usage: Record<string, unknown>;

  timing: Record<string, unknown>;

  rawMetadata: Record<string, unknown>;

  error?: {
    code?: string;
    message: string;
    stack?: string;
  };
}
```

Trajectory 不要塞在：

```ts
AgentRunResult
```

Trajectory 使用 Recorder 单独处理。

---

# 8.2 ClineCoreAdapter

将当前：

```text
ClineCore Runtime
```

包装成：

```ts
export class ClineCoreAdapter
  implements AgentAdapter {
  // ...
}
```

要求：

```text
不重新实现 ClineCore

不改变调用参数

不改变 Tool Permission 行为

不改变 Session 行为

只增加 Adapter 层
```

---

# 8.3 TrialRunner 依赖反转

修改前可能类似：

```text
TrialRunner
    ↓
ClineCore
```

修改后：

```text
TrialRunner
    ↓
AgentAdapter
```

禁止：

```ts
if (agent === "cline") {
  // 大量 cline specific logic
}
```

出现在 TrialRunner。

Agent-specific 行为应该留在：

```text
ClineCoreAdapter
```

---

# 9. Phase 4B：EnvironmentProvider

定义：

```ts
export interface EvaluationEnvironment {
  id: string;

  workspacePath: string;

  sessionPath?: string;

  capabilities: IsolationCapabilities;

  metadata: Record<string, unknown>;
}
```

```ts
export interface EnvironmentProvider {
  create(
    trial: Trial,
  ): Promise<EvaluationEnvironment>;

  collectArtifacts(
    environment: EvaluationEnvironment,
  ): Promise<Artifact[]>;

  destroy(
    environment: EvaluationEnvironment,
  ): Promise<void>;
}
```

---

# 9.1 LocalWorkspaceProvider

把当前已有：

```text
Process Isolation

Session Directory

Workspace

Fixture Copy

Empty Workspace

Baseline Snapshot

Final Snapshot

File Diff
```

包装进：

```ts
export class LocalWorkspaceProvider
  implements EnvironmentProvider {
  // ...
}
```

不重新实现原有逻辑。

---

# 9.2 IsolationCapabilities

```ts
export interface IsolationCapabilities {
  process: boolean;

  workspace: boolean;

  filesystem: boolean;

  network: boolean;

  os: boolean;
}
```

当前必须：

```ts
const LOCAL_WORKSPACE_CAPABILITIES:
  IsolationCapabilities = {
    process: true,

    workspace: true,

    filesystem: false,

    network: false,

    os: false,
  };
```

禁止把当前 Environment 叫：

```text
Secure Sandbox
```

产品上应叫：

```text
Local Workspace Isolation
```

或：

```text
Workspace Environment
```

---

# 9.3 TrialRunner

不得直接：

```text
mkdir workspace

copy fixture

collect file diff
```

这些逻辑应该经：

```text
EnvironmentProvider
```

调用。

---

# 10. Phase 5：Trajectory

定义：

```ts
export type TrajectoryEventType =
  | "message"
  | "tool_request"
  | "tool_result"
  | "runtime_event"
  | "error"
  | "finish";

export interface TrajectoryEvent {
  seq: number;

  timestamp: string;

  type: TrajectoryEventType;

  source: string;

  payload: Record<string, unknown>;
}
```

---

# 10.1 TrajectoryRecorder

```ts
export interface TrajectoryRecorder {
  record(
    event: Omit<TrajectoryEvent, "seq">,
  ): void;

  getEvents(): TrajectoryEvent[];

  flush(
    outputPath: string,
  ): Promise<void>;
}
```

---

# 10.2 兼容现有 Trace

不要强制 ClineCore 立即产出新格式。

增加：

```ts
export interface TrajectoryNormalizer<T> {
  normalize(
    event: T,
  ): TrajectoryEvent | null;
}
```

例如：

```text
Cline Diagnostic Event
       ↓
ClineTrajectoryNormalizer
       ↓
TrajectoryEvent
```

---

# 11. Phase 5B：Evidence

这一部分必须严格实现。

---

# 11.1 核心原则

```text
Trajectory
≠
Evidence
```

尤其：

```text
tool_request
```

只能证明：

```text
Agent 发起了 Tool 请求
```

不能证明：

```text
Tool 真正执行成功
```

---

# 11.2 Diagnostic Evidence

来自：

```text
Assistant Message

Tool Request

Model Decision
```

生成：

```ts
trustLevel:
  EvidenceTrustLevel.Diagnostic
```

---

# 11.3 Runtime Evidence

只有 Runtime 真正观察：

```text
Process Exit

Tool Wrapper Response

Command Execution Result
```

才能：

```ts
trustLevel:
  EvidenceTrustLevel.RuntimeObserved
```

---

# 11.4 Artifact Evidence

来自：

```text
File Exists

File Hash

File Diff

Workspace Snapshot
```

使用：

```ts
EvidenceTrustLevel.ArtifactObserved
```

---

# 11.5 Verifier Evidence

来自：

```text
Test Script

pytest equivalent

npm test

Custom Verifier
```

使用：

```ts
EvidenceTrustLevel.VerifierObserved
```

---

# 11.6 Approval

当前如果没有真实 Audit Event：

```text
approval happened
```

相关 Verification Rule：

```text
必须 UNSUPPORTED
```

禁止根据：

```text
Agent Trace
```

判断审批成功。

---

# 11.7 Evidence Matcher

建议提供：

```ts
export function satisfiesTrustLevel(
  evidenceLevel: EvidenceTrustLevel,
  requiredLevel: EvidenceTrustLevel,
): boolean;
```

不要在多个 Rule 中分别：

```text
手写 evidence level 判断
```

---

# 12. Phase 6：Verifier

---

# 12.1 Base Interface

```ts
export interface VerificationContext {
  trial: Trial;

  agentResult: AgentRunResult;

  trajectory: TrajectoryEvent[];

  artifacts: Artifact[];

  evidence: Evidence[];

  workspacePath?: string;
}
```

```ts
export interface Verifier {
  verify(
    context: VerificationContext,
  ): Promise<VerifierResult>;
}
```

---

# 12.2 RuleVerifier

包装当前已有：

```text
Text Assertion

Finish Reason

File Exists

File Content

JSON Rule

File Unchanged
```

不要重新实现现有 Rule Engine。

---

# 12.3 CommandVerifier

现有：

```text
Command Verification
```

包装为：

```ts
export class CommandVerifier
  implements Verifier {
  // ...
}
```

---

# 12.4 ScriptVerifier

包装：

```text
Script Verification
```

并逐渐允许：

```text
tests/test.sh

tests/verifier.js

tests/verifier.ts
```

注意：

直接执行 `.ts` 需要项目已有 TS Runtime。

如果当前项目没有：

```text
tsx / ts-node
```

不要为了 verifier.ts 强制新增。

可以要求：

```text
verifier.js
```

或者：

```text
通过项目已有构建链路执行
```

根据仓库实际情况决定。

---

# 12.5 VerifierPipeline

```ts
export class VerifierPipeline {
  constructor(
    private readonly verifiers: Verifier[],
  ) {}

  async verify(
    context: VerificationContext,
  ): Promise<VerifierResult> {
    // ...
  }
}
```

职责：

```text
顺序执行 Verifier

隔离异常

合并 Criterion

合并 Metrics

计算最终 Status
```

---

# 12.6 Required Rule

如果：

```text
required = true
status = fail
```

则：

```text
verification.passed = false
```

如果：

```text
required = true
status = unsupported
```

则：

```text
verification.status = unsupported

verification.passed = null
```

---

# 12.7 Optional Rule

Optional：

```text
fail
```

不能让：

```text
required conditions
```

自动失败。

但结果必须保存。

---

# 12.8 Error

Verifier 自己抛异常：

```text
不能转换为 task fail
```

应：

```text
RuleStatus.Error
```

或：

```text
verification.status = error
```

---

# 12.9 HarborRewardExporter

实现独立：

```ts
export class HarborRewardExporter {
  export(
    result: VerifierResult,
  ): Record<string, number> {
    // ...
  }
}
```

例如：

```json
{
  "task_success": 1,
  "required_pass_rate": 1,
  "optional_pass_rate": 0.8
}
```

Reward 只是：

```text
兼容输出
```

内部真实数据结构仍为：

```text
VerifierResult
```

---

# 13. Phase 7：TrialRunner

目标流程：

```ts
export class TrialRunner {
  constructor(
    private readonly agentAdapter: AgentAdapter,

    private readonly environmentProvider:
      EnvironmentProvider,

    private readonly verifierPipeline:
      VerifierPipeline,

    private readonly resultStore:
      ResultStore,
  ) {}

  async run(
    trial: Trial,
  ): Promise<TrialResult> {
    // ...
  }
}
```

逻辑：

```text
1. status = preparing

2. environment.create()

3. agent.setup()

4. status = running

5. agent.run()

6. save trajectory

7. collect artifacts

8. status = verifying

9. verifier.verify()

10. build TrialResult

11. save result

12. cleanup agent

13. cleanup environment
```

---

# 13.1 Cleanup

必须使用：

```ts
try {
  // ...
} finally {
  // cleanup
}
```

保证：

```text
Agent Error

Verifier Error

Cancel
```

都执行 cleanup。

---

# 13.2 Partial Result

发生错误后仍保存：

```text
已有 Trajectory

已有 Final Answer

已有 Artifacts

Error

Timing
```

不要：

```text
出错就完全没有 Result
```

---

# 14. JobRunner

现有 Batch / Concurrent Runner 包装为：

```ts
export interface JobRunOptions {
  concurrency: number;
}
```

```ts
export class JobRunner {
  async run(
    job: Job,
    options: JobRunOptions,
  ): Promise<JobResult> {
    // ...
  }
}
```

---

# 14.1 Concurrency

优先复用现有并发机制。

如果现在已经：

```text
Promise Pool

Semaphore

Queue
```

不要重写。

---

# 14.2 Cancellation

建议使用项目已有：

```text
AbortController / AbortSignal
```

如果已有其他 cancellation token：

```text
保持现有实现
```

不要为了规范强制切换。

目标是：

```text
Job Cancel
     ↓
Running Trial Cancel
     ↓
Agent Cleanup
     ↓
Environment Cleanup
     ↓
Partial Result
```

---

# 15. Result Storage

目标结构：

```text
jobs/
└── <job-id>/
    ├── config.json
    ├── result.json
    │
    └── trials/
        └── <trial-id>/
            ├── config.json
            ├── result.json
            │
            ├── agent/
            │   ├── trajectory.json
            │   ├── final-answer.txt
            │   └── session.json
            │
            ├── artifacts/
            │   ├── manifest.json
            │   └── ...
            │
            └── verifier/
                ├── result.json
                ├── reward.json
                ├── stdout.log
                └── stderr.log
```

---

# 15.1 ResultStore

```ts
export interface ResultStore {
  saveTrialConfig(
    trial: Trial,
  ): Promise<void>;

  saveTrialResult(
    result: TrialResult,
  ): Promise<void>;

  loadTrialResult(
    trialId: string,
  ): Promise<TrialResult | null>;

  saveJobResult(
    result: JobResult,
  ): Promise<void>;
}
```

---

# 15.2 Schema Version

所有新 Result：

```json
{
  "schemaVersion": "1.1"
}
```

旧 Result 不要立即迁移。

Reader 继续支持：

```text
Legacy Result

New Result
```

---

# 15.3 Report

现有：

```text
JSON

CSV

Markdown
```

改为消费：

```text
TrialResult

JobResult
```

而不是直接读取 Runtime 私有状态。

---

# 16. Task Migration

实现：

```text
Legacy Case
     ↓
Migration
     ↓
Task Package
```

根据现有 CLI 体系决定命令形式。

如果项目已有 CLI：

```text
加入 migrate-case
```

否则可以先实现 Service：

```ts
export interface CaseMigrationService {
  migrateCase(
    sourcePath: string,
    destinationPath: string,
  ): Promise<MigrationResult>;
}
```

不要为了一个 Migration Command 新建完整 CLI Framework。

---

# 16.1 Migration Result

```ts
export interface MigrationResult {
  source: string;

  target: string;

  status: "success" | "failed";

  mappedFields: string[];

  unmappedFields: string[];

  warnings: string[];

  errors: string[];
}
```

要求：

```text
任何字段无法迁移
必须记录
```

禁止：

```text
静默丢字段
```

---

# 16.2 输出

迁移后：

```text
task.toml

instruction.md

context/messages.json

environment/fixture/

tests/assertions.yaml
```

按 Case 实际需要生成。

---

# 16.3 自动验证

迁移完成：

```text
TaskLoader.validate()
```

随后比较：

```text
Legacy TaskDefinition

vs

Task Package TaskDefinition
```

主要检查：

```text
instruction

context

module

tags

workspace

fixture

rules

timeout

tool permissions
```

---

# 17. Golden Cases

必须建立 Golden Regression Cases。

至少：

```text
G01 single-turn-basic

G02 single-turn-with-history

G03 text-assertion

G04 tool-diagnostic

G05 full-task-empty-workspace

G06 full-task-fixture

G07 file-created

G08 file-unchanged

G09 json-rule

G10 command-verifier

G11 script-verifier

G12 required-optional

G13 repeat-3

G14 batch-multiple

G15 cancellation
```

---

# 17.1 Characterization Tests

如果这些逻辑目前没有测试：

```text
先记录旧系统当前行为
```

特别是：

```text
ClineCore Request Construction

Context Replay

Fixture Copy

File Diff

Rules

Repeat

Batch

Cancel
```

原则：

> 先 Characterize，再 Refactor。

不要先“顺手修正”旧行为。

---

# 18. Behavior Parity

重构前后比较：

```text
Instruction

Context

Workspace Initial State

Agent Config

Model Config

Tool Permission

Max Iterations

Timeout

Final Answer

Finish Reason

Workspace Diff

Verification Result
```

除了：

```text
Evidence Trust / Unsupported
```

相关修正外，其他行为不能无意变化。

---

# 19. UI 修改边界

不重新设计 UI。

只做必要修改。

---

# 19.1 Case Detail

增加：

```text
Task Version

Task Type

Task Schema Version

Storage Format
```

---

# 19.2 Environment

必须展示：

```text
Provider: Local Workspace

Process Isolation: Yes

Workspace Isolation: Yes

Filesystem Sandbox: No

Network Isolation: No

OS Isolation: No
```

禁止显示：

```text
Secure Sandbox
```

---

# 19.3 Verification

状态支持：

```text
PASS

FAIL

UNSUPPORTED

ERROR

SKIPPED
```

---

# 19.4 Trial Detail

展示：

```text
Task Version

Agent Version

Agent Git Commit

Model

Model Config Hash

Attempt

Trajectory

Artifacts

Evidence

Verifier Result
```

---

# 20. Error Handling

统一生命周期：

```text
pending

preparing

running

verifying

completed

cancelled

error
```

---

## Agent Error

```text
Trial.status = error
```

但保存已有：

```text
Trajectory

Artifacts

Usage

Timing

Error
```

---

## Verifier Error

不能：

```text
Agent 执行成功
Verifier 崩溃
→ task failed
```

应：

```text
verification.status = error
```

---

## Cancel

必须：

```text
Abort Agent

Agent Cleanup

Environment Cleanup

Save Partial Result
```

---

# 21. Logging

日志尽可能结构化。

核心日志必须包含：

```text
jobId

trialId

taskId

attempt
```

例如：

```ts
logger.info({
  event: "trial_started",

  jobId: job.id,

  trialId: trial.id,

  taskId: trial.task.id,

  attempt: trial.attempt,
});
```

不要只：

```ts
console.log("starting evaluation");
```

如果项目已有统一 Logger：

```text
必须复用
```

---

# 22. Sensitive Data

不得把以下内容持久化：

```text
API Key

Authorization Header

Password

Access Token

Secret Token
```

需要统一：

```ts
export function redactSensitiveData(
  value: unknown,
): unknown;
```

优先复用已有安全工具。

应用到：

```text
Model Config

Runtime Config

Log

Result

Debug Metadata
```

---

# 23. 本次明确不实现

V1.1 禁止扩展为：

```text
Docker Sandbox

Kubernetes

Remote Worker

Distributed Scheduler

LLM Judge

Re-score UI

Trajectory Scanner

Baseline / Candidate Automatic Compare

Online Evaluation

Separate Verifier Container

Network Allowlist

CPU / GPU Resource Quota

完整 ATIF Migration
```

可以：

```text
预留 interface
```

但不要实现。

---

# 24. 后续扩展必须满足

## Docker

未来可以直接：

```ts
export class DockerEnvironmentProvider
  implements EnvironmentProvider {
  // ...
}
```

而不改 TrialRunner。

---

## New Agent

未来：

```ts
export class ClaudeCodeAdapter
  implements AgentAdapter {
  // ...
}
```

而不改 TrialRunner。

---

## LLM Judge

未来：

```ts
export class LlmJudgeVerifier
  implements Verifier {
  // ...
}
```

而不改 AgentAdapter。

---

## Re-score

历史 Trial 必须保存足够数据：

```text
Trajectory
+
Artifacts
+
Agent Result
+
Task Snapshot
```

使未来可以：

```text
旧 Trial
+
新 Verifier
→
新 VerifierResult
```

而不重跑 Agent。

---

# 25. 推荐执行顺序

必须按顺序：

```text
Phase 0
Current State Scan

↓

Phase 1
Core Domain

↓

Phase 2
Task Package / Loader / Legacy Adapter

↓

Phase 3
Trial / Job

↓

Phase 4
AgentAdapter / EnvironmentProvider

↓

Phase 5
Trajectory / Evidence

↓

Phase 6
Verifier Pipeline

↓

Phase 7
TrialRunner / Result Storage

↓

Migration Tool

↓

Golden Regression

↓

UI Minimal Adaptation

↓

Cleanup
```

---

# 26. 每阶段执行要求

每个 Phase 完成后必须：

```text
1. Type Check

2. Unit Test

3. Existing Test Suite

4. Golden Regression

5. Fix Regression

6. 再进入下一 Phase
```

对于 TS 项目至少执行仓库已有的：

```text
typecheck

lint

test
```

具体命令先读取：

```text
package.json
```

不得猜：

```text
npm test

pnpm test

bun test
```

实际使用哪个 Package Manager。

---

# 27. 包管理器规则

开始前检查：

```text
package.json

package-lock.json

pnpm-lock.yaml

yarn.lock

bun.lock / bun.lockb
```

遵循当前项目的 Package Manager。

禁止因为本次重构：

```text
npm → pnpm

pnpm → bun

bun → npm
```

等无关迁移。

---

# 28. TypeScript 规则

优先遵循项目当前：

```text
tsconfig.json

eslint config

prettier config

import convention

path alias
```

禁止本次顺带：

```text
修改全局 strict 配置

替换 eslint

替换 formatter

重构 unrelated imports
```

---

# 29. 类型原则

新增模块禁止大量：

```ts
any
```

确实未知的数据使用：

```ts
unknown
```

例如：

```ts
Record<string, unknown>
```

需要访问时做：

```text
type narrowing
```

---

# 30. Runtime Validation

TypeScript Interface 只提供：

```text
Compile-time validation
```

Task Package 是外部数据，因此必须：

```text
Runtime Validation
```

如果项目已有：

```text
zod
ajv
valibot
io-ts
```

优先复用。

如果没有，不要未经必要性评估引入大型 Schema Framework。

至少要手工验证：

```text
task.toml

context/messages.json

assertions.yaml
```

外部输入。

---

# 31. Definition of Done

V1.1 必须同时满足：

```text
[ ] Phase 0 仓库现状分析完成

[ ] 新 Case 可以使用 Task Package

[ ] task.toml 可以加载

[ ] instruction.md 可以加载

[ ] context/messages.json 可以加载

[ ] Legacy Case 仍可执行

[ ] Runtime 不直接依赖 LegacyCase

[ ] TaskDefinition 与 Trial 分离

[ ] Repeat = 多个 Trial

[ ] Batch = Job + Trials

[ ] ClineCore 已包装为 AgentAdapter

[ ] TrialRunner 不直接依赖 ClineCore

[ ] Workspace 已包装为 EnvironmentProvider

[ ] TrialRunner 不直接负责 Fixture Copy

[ ] 当前 Environment 明确非安全 Sandbox

[ ] Trajectory 已标准化

[ ] Trajectory 与 Evidence 分离

[ ] tool_request 不等于 tool_executed

[ ] Evidence Trust Level 已实现

[ ] Verification 支持 UNSUPPORTED

[ ] RuleVerifier 已适配现有 Rule Engine

[ ] CommandVerifier 已适配

[ ] ScriptVerifier 已适配

[ ] Required / Optional 语义正确

[ ] TrialResult Schema 已实现

[ ] JobResult 已实现

[ ] 新 Result 存在 schemaVersion

[ ] 历史 Result 仍然可读

[ ] Snapshot Re-run 继续有效

[ ] 1–100 Repeat 继续有效

[ ] Batch Concurrency 继续有效

[ ] Cancellation 继续有效

[ ] JSON Export 继续有效

[ ] CSV Export 继续有效

[ ] Markdown Export 继续有效

[ ] Migration Tool 可用

[ ] Migration 不静默丢字段

[ ] Golden Cases 全部通过

[ ] Type Check 通过

[ ] Existing Tests 通过

[ ] 新模块 Unit Tests 完成
```

---

# 32. Documentation

完成后至少更新：

```text
docs/
├── architecture.md
├── task-format.md
├── verification.md
└── migration.md
```

---

## architecture.md

解释：

```text
Task

Trial

Job

AgentAdapter

EnvironmentProvider

Trajectory

Artifact

Evidence

Verifier

TrialResult
```

---

## task-format.md

必须包含：

```text
Task Package 目录

task.toml

instruction.md

context/

environment/

tests/

solution/
```

并提供：

```text
Single-turn Example

Full-task Example
```

---

## verification.md

必须重点说明：

```text
Trajectory ≠ Evidence

Diagnostic Evidence

Runtime Evidence

Artifact Evidence

Verifier Evidence

UNSUPPORTED

Required / Optional
```

---

## migration.md

说明：

```text
Legacy Case

↓

Task Package
```

字段映射和迁移方式。

---

# 33. 最终交付物

Agent 完成整个任务后必须提供：

```text
1. 修改后的代码

2. 当前仓库分析文档

3. Task Package Format

4. TaskLoader

5. LegacyCaseAdapter

6. TaskDefinition

7. Trial / Job

8. AgentAdapter

9. ClineCoreAdapter

10. EnvironmentProvider

11. LocalWorkspaceProvider

12. Trajectory Model

13. Evidence Model

14. Verifier Pipeline

15. TrialResult / JobResult

16. Migration Tool / Service

17. Unit Tests

18. Golden Regression Cases

19. architecture.md

20. task-format.md

21. verification.md

22. migration.md
```

最终回复必须总结：

```text
Modified Files

New Files

Architecture Changes

Legacy Compatibility

Migration Status

Tests Executed

Type Check Result

Test Results

Known Limitations

Remaining TODO
```

---

# 34. 最终禁止事项

整个任务期间禁止：

```text
未经确认删除旧 Case

未经确认批量修改原始 Case

重新实现 ClineCore

修改模型调用协议

修改 Tool Permission 语义

把 Local Workspace 描述为安全 Sandbox

用 Diagnostic Trace 证明真实 Tool Execution

无法验证的 Required Rule 判 PASS

删除历史 Result

修改历史 Result

切换 Package Manager

替换测试框架

大规模格式化整个仓库

顺带重构与 Evaluation 无关代码
```

---

# 35. 最终状态

重构前：

```text
Case
 ↓
现有业务 Runtime
 ↓
ClineCore
 ↓
Workspace
 ↓
Rules
 ↓
Result
```

重构后：

```text
Task Package
      ↓
TaskLoader
      ↓
TaskDefinition
      ↓
Trial
      ↓
┌─────────────────────────┐
│ AgentAdapter            │
│ ModelConfig             │
│ EnvironmentProvider     │
└────────────┬────────────┘
             ↓
       Agent Execution
             ↓
┌─────────────────────────┐
│ Trajectory              │
│ Artifact                │
│ Evidence                │
└────────────┬────────────┘
             ↓
      Verifier Pipeline
             ↓
         TrialResult
             ↓
        Job / Experiment
```

本轮重构最终必须建立五个稳定边界：

```text
Task ≠ Trial

Agent ≠ Runtime

Environment ≠ Agent

Trajectory ≠ Evidence

Execution ≠ Scoring
```

如果现有仓库结构和本文给出的文件名、接口名不一致：

> **优先保持职责边界和架构目标，不要为了机械匹配 Spec 而重复创建已有能力。**

如果发现本文要求与现有实现发生冲突：

```text
1. 优先保证现有行为兼容

2. 在 docs/refactor/v1_1-current-state.md 中记录冲突

3. 选择最小侵入式实现

4. 不要自行删除已有能力
```
