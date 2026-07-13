# Pi Agent 项目简历表述

## 推荐项目名称

**Pi Agent 源码学习与智能编码扩展开发（个人项目）**　`[按实际填写时间]`

**技术栈：** TypeScript、Node.js、LLM Agent、MCP、Multi-Agent、JSONL、AsyncIterator、OAuth 2.1、sandbox-exec、Bubblewrap

## 项目描述

以开源 Pi Agent 为源码学习基座，围绕复杂任务拆解、MCP 工具上下文膨胀和本地命令安全三个问题，自主设计并开发 `pi-subagents`、`pi-mcp-adapter`、`pi-sandbox` 三个可插拔扩展，形成覆盖 Agent 运行时、多 Agent 编排、外部工具接入和执行安全的一体化终端智能编码平台。

## 项目亮点

- **Agent 内核源码学习：** 深入分析 `AgentSession -> Agent -> runAgentLoop` 执行链路，掌握基于 AsyncIterator 的 LLM 流式事件处理、Text/Thinking/ToolCall 增量消息拼接、工具串并行调度、Steering/Follow-up 消息队列及 AbortSignal 取消机制；通过 `AgentEvent` 解耦运行状态、TUI 展示、会话持久化和扩展监听器，为三个扩展提供统一生命周期基础。

- **长上下文与会话记忆：** 基于 Pi 的 append-only JSONL 会话树研究并实践分支恢复、模型/Thinking 配置追踪和历史上下文重建；在上下文达到阈值时调用 LLM 生成压缩摘要，并将 compaction/branch summary 作为树节点持久化，使后续加载可直接复用摘要，在保留关键决策和工具结果的同时控制长会话 Token 开销。

- **自主开发 Multi-Agent 编排扩展：** 将子 Agent 抽象为父 Agent 可调用的 `subagent` 工具，通过 `spawn("pi", ["--mode", "json", "-p"])` 启动独立 Pi 子进程和 AgentSession，隔离模型上下文、工具集和失败状态；实现 Single、Parallel、Chain、Background **4 种执行模式**及 Scout、Planner、Worker、Reviewer 等 **8 类内置角色**，支持默认 **4 路并发**、运行中止、结果恢复和后台任务查询。

- **完善多 Agent 可观测性：** 解析子进程 JSONL AgentEvent，实时聚合模型输出、工具调用、步骤状态和错误，通过父工具 `onUpdate` 回传进度；为异步任务持久化 `status.json`、`events.jsonl`、transcript 和最终 result，统一记录 Token、Cost、Tool Count、Turn Count 等指标，并通过子进程环境标识与最大深度控制防止无约束递归派生。

- **自主开发低上下文 MCP Adapter：** 针对传统 MCP 将大量 Tool Schema 常驻系统提示词、单个 Server 可能消耗 **10k+ Token** 的问题，设计单一 `mcp` Proxy Tool，通过 Search、Describe、Connect、Call 四阶段按需发现工具，将常驻工具描述收敛为约 **200 Token**，理论上下文开销降低 **98%+**；同时支持按需提升高频 Direct Tools，在上下文成本与调用效率之间动态权衡。

- **优化 MCP 启动与连接成本：** 设计基于 Server 配置哈希的 metadata cache，使工具名称、描述、JSON Schema 和 Resource 在 Server 未连接时仍可搜索；设置缓存默认 **7 天有效**、Lazy Server 默认按需连接并在 **10 分钟**空闲后回收，初始化采用最高 **10 路并发**，避免多个 stdio Server 随 Pi 启动集中拉起，降低启动等待和常驻进程开销。

- **增强 MCP 协议完整性与稳定性：** 基于官方 MCP SDK 实现 stdio、Streamable HTTP 和 SSE fallback 三类传输，支持 Bearer/OAuth 2.1、Sampling、Elicitation、Resources 和 MCP Apps UI；通过连接 Promise 去重、失败 60 秒退避、AbortSignal 透传和 session shutdown 清理处理连接竞态，并将模型可见输出限制为 **50 KiB / 2,000 行**、原始 details 限制为 **16 KiB**，超限内容落盘，避免工具输出挤爆上下文。

- **自主开发双层安全 Sandbox 扩展：** 覆盖 Pi 内置 `bash` 工具，将 shell 命令交由 macOS `sandbox-exec` 或 Linux Bubblewrap 执行，在 OS 层限制整个子进程树的文件和网络权限；针对直接运行于 Node.js 主进程、无法被子进程沙箱覆盖的 `read/write/edit`，利用 `tool_call` hook 在执行前实施路径策略检查，形成“OS 强制隔离 + Agent 工具拦截”的双层防护。

- **设计交互式最小权限模型：** 对未授权域名和读写路径提供 Session、Project、Global 三种授权范围及 Abort 选项，分别保存在内存、`.pi/sandbox.json` 和用户级配置中；通过 realpath canonicalization 处理 `..`、symlink 和不存在的写入目标，采用 `allowRead > denyRead`、`denyWrite > allowWrite` 的差异化优先级，确保项目目录可工作，同时硬阻止 `.env`、PEM、Key 等敏感文件写入。

- **扩展工程化与可插拔设计：** 按 Pi `package.json#pi` 规范封装三个 npm 扩展，通过 `pi install npm:<package>` 完成用户级/项目级安装；统一使用 ExtensionAPI 注册 Tool、Command、Flag 和 Lifecycle Event，并围绕配置合并、初始化竞态、资源回收、错误传播和无 UI 降级设计边界，使扩展能够独立安装、按需启用且不侵入 Agent Loop 主流程。

## STAR / XYZ 结构拆解

### Situation

通用 Coding Agent 面临三个工程问题：复杂任务难以在单上下文中并行处理；MCP 工具 Schema 造成较高固定 Token 成本；本地 shell 和文件工具权限过大。

### Task

在不修改 Pi Agent ReAct 主循环的前提下，通过扩展系统补齐多 Agent 编排、低成本 MCP 接入和本地执行隔离能力，同时保持流式反馈、会话恢复和插件化安装体验。

### Action

- 基于 ExtensionAPI 和 AgentEvent 接入工具执行边界与生命周期。
- 使用独立 Pi 子进程构建多 Agent 调度和 JSONL 事件聚合。
- 使用 Proxy Tool、metadata cache 和 lazy lifecycle 优化 MCP 上下文与连接成本。
- 使用 OS sandbox 与 `tool_call` policy 构建双层权限控制。

### Result

- 提供 4 种子 Agent 执行模式、8 类角色和默认 4 路并发。
- 将 MCP 常驻上下文从单 Server 可能的 10k+ Token 收敛到约 200 Token，理论降低 98%+。
- 通过 7 天 metadata cache、10 分钟 idle 回收和 10 路初始化并发减少 MCP 启动与常驻成本。
- 将 50 KiB/2,000 行以上输出转为预览加落盘，控制工具结果对上下文的冲击。
- 对 bash 进程树和 read/write/edit 工具分别实施 OS 层与应用层权限控制。

## 面试时的项目边界

建议主动说明：

> Pi Agent 内核是我的开源源码学习对象，我重点研究了 Agent Loop、EventStream、Session 和记忆机制；在理解这些扩展点后，我围绕多 Agent、MCP 和安全执行三个方向自主完成了扩展设计与实现。

这样可以把“开源学习”和“个人实现”清楚分开。面试官继续追问时，可以分别展开：

- Agent 内核：事件驱动 ReAct、工具调用循环、监听器结算、JSONL 会话树和 AI 压缩。
- Subagents：为什么使用独立进程、如何汇总事件、如何控制递归和并发。
- MCP Adapter：为什么使用 Proxy Tool、缓存为何能支持 Direct Tools、如何管理连接生命周期。
- Sandbox：为什么 bash 和 read/write/edit 需要两套拦截机制、哪些能力不在隔离范围内。

## 需要按真实情况补充的数据

如果后续完成真实 Benchmark，可把源码设计指标替换成更有说服力的实测结果：

- 接入的 MCP Server 数量和工具总数。
- 同一任务启用 Adapter 前后的 System Prompt Token 数。
- Pi 冷启动耗时、常驻 MCP 进程数和内存变化。
- Multi-Agent 在代码审查/检索任务上的耗时或问题召回率变化。
- Sandbox 拦截的敏感路径、非法网络访问和误报数量。

没有实测前，不建议编造“效率提升 70%”“准确率提升 30%”等业务指标；当前文案中的数字都来自可在源码或配置中解释的架构指标。
