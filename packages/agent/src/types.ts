import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
	Tool,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";

/**
 * Agent 循环使用的流式函数。`Models.streamSimple` 满足此签名。
 *
 * 约定：
 * - 请求/模型/运行时失败时不得抛出异常或返回 rejected promise。
 * - 必须返回 AssistantMessageEventStream。
 * - 失败须通过协议事件及最终 stopReason 为 "error" 或 "aborted" 且带 errorMessage 的 AssistantMessage 编码在返回的流中。
 */
export type StreamFn = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/**
 * 单条 assistant 消息中各 tool call 的执行方式配置。
 *
 * - "sequential"：每个 tool call 依次完成准备、执行、收尾后再处理下一个。
 * - "parallel"：tool call 按序准备，允许的工具并发执行。
 *   每个工具收尾后按完成顺序发出 `tool_execution_end`，
 *   tool result 消息产物则稍后在 assistant 源顺序中发出。
 */
export type ToolExecutionMode = "sequential" | "parallel";

/**
 * Agent 循环到达队列 drain 点时，注入多少条排队 user 消息。
 *
 * - "all"：在该点 drain 并注入全部排队消息。
 * - "one-at-a-time"：仅 drain 并注入最早的一条，其余留待后续 drain 点。
 */
export type QueueMode = "all" | "one-at-a-time";

/** Assistant 消息发出的单个 tool call 内容块。 */
export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

/**
 * `beforeToolCall` 的返回值。
 *
 * 返回 `{ block: true }` 将阻止工具执行；循环会改为发出 error tool result。
 * `reason` 作为该 error result 中的文本；省略时使用默认拦截消息。
 */
export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
}

/**
 * `afterToolCall` 返回的部分覆盖。
 *
 * 合并语义为逐字段：
 * - `content`：若提供，完整替换 tool result 的 content 数组
 * - `details`：若提供，完整替换 tool result 的 details
 * - `isError`：若提供，替换 error 标志
 * - `terminate`：若提供，替换提前终止提示
 *
 * 省略的字段保留原执行结果。
 * `content` 与 `details` 不做深度合并。
 */
export interface AfterToolCallResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	isError?: boolean;
	/**
	 * 提示 agent 在当前 tool batch 结束后停止。
	 * 仅当 batch 内每个已收尾 tool result 均设为 true 时才会提前终止。
	 */
	terminate?: boolean;
}

/** 传给 `beforeToolCall` 的上下文。 */
export interface BeforeToolCallContext {
	/** 发起该 tool call 的 assistant 消息。 */
	assistantMessage: AssistantMessage;
	/** 来自 `assistantMessage.content` 的原始 tool call 块。 */
	toolCall: AgentToolCall;
	/** 针对目标 tool schema 校验后的参数。 */
	args: unknown;
	/** 准备该 tool call 时的 agent 上下文。 */
	context: AgentContext;
}

/** 传给 `afterToolCall` 的上下文。 */
export interface AfterToolCallContext {
	/** 发起该 tool call 的 assistant 消息。 */
	assistantMessage: AssistantMessage;
	/** 来自 `assistantMessage.content` 的原始 tool call 块。 */
	toolCall: AgentToolCall;
	/** 针对目标 tool schema 校验后的参数。 */
	args: unknown;
	/** 应用 `afterToolCall` 覆盖前的执行结果。 */
	result: AgentToolResult<any>;
	/** 当前执行结果是否视为 error。 */
	isError: boolean;
	/** 收尾该 tool call 时的 agent 上下文。 */
	context: AgentContext;
}

/** 传给 `shouldStopAfterTurn` 的上下文。 */
export interface ShouldStopAfterTurnContext {
	/** 完成该 turn 的 assistant 消息。 */
	message: AssistantMessage;
	/** 传给前序 `turn_end` 事件的 tool result 消息。 */
	toolResults: ToolResultMessage[];
	/** 该 turn 的 assistant 消息与 tool result 追加后的 agent 上下文。 */
	context: AgentContext;
	/** 若循环在此退出将返回的消息。prompt 运行包含初始 prompt 消息；continuation 运行不包含既有上下文消息。 */
	newMessages: AgentMessage[];
}

/** 在发起下一次 provider 请求前，agent 循环使用的替换运行时状态。 */
export interface AgentLoopTurnUpdate {
	/** 下一次 provider 请求的上下文。 */
	context?: AgentContext;
	/** 下一次 provider 请求的模型。 */
	model?: Model<any>;
	/** 下一次 provider 请求的 thinking level。 */
	thinkingLevel?: ThinkingLevel;
}

export interface PrepareNextTurnContext extends ShouldStopAfterTurnContext {}

export interface AgentLoopConfig extends SimpleStreamOptions {
	model: Model<any>;

	/**
	 * 每次 LLM 调用前将 AgentMessage[] 转为 LLM 可理解的 Message[]。
	 *
	 * 每条 AgentMessage 须转为 UserMessage、AssistantMessage 或 ToolResultMessage。
	 * 无法转换的 AgentMessage（如仅 UI 的通知、状态消息）应过滤掉。
	 *
	 * 约定：不得抛出或 reject；应返回安全的回退值。
	 * 抛错会中断底层 agent 循环且不产生正常事件序列。
	 *
	 * @example
	 * ```typescript
	 * convertToLlm: (messages) => messages.flatMap(m => {
	 *   if (m.role === "custom") {
	 *     // 将自定义消息转为 user 消息
	 *     return [{ role: "user", content: m.content, timestamp: m.timestamp }];
	 *   }
	 *   if (m.role === "notification") {
	 *     // 过滤仅 UI 的消息
	 *     return [];
	 *   }
	 *   // 透传标准 LLM 消息
	 *   return [m];
	 * })
	 * ```
	 */
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	/**
	 * 在 `convertToLlm` 之前对上下文应用的可选变换。
	 *
	 * 用于 AgentMessage 层面的操作，例如：
	 * - 上下文窗口管理（裁剪旧消息）
	 * - 注入外部来源的上下文
	 *
	 * 约定：不得抛出或 reject；应返回原消息或其它安全回退值。
	 *
	 * @example
	 * ```typescript
	 * transformContext: async (messages) => {
	 *   if (estimateTokens(messages) > MAX_TOKENS) {
	 *     return pruneOldMessages(messages);
	 *   }
	 *   return messages;
	 * }
	 * ```
	 */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

	/**
	 * 每次 LLM 调用时动态解析 API key。
	 *
	 * 适用于长时间 tool 执行阶段可能过期的短期 OAuth token（如 GitHub Copilot）。
	 *
	 * 约定：不得抛出或 reject；无可用 key 时返回 undefined。
	 */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

	/**
	 * 每个 turn 完全结束且已发出 `turn_end` 后调用。
	 *
	 * 若返回 true，循环在轮询 steering 或 follow-up 队列、发起下一次 LLM 调用之前
	 * 发出 `agent_end` 并退出；当前 assistant 响应及 tool 执行仍正常完成。
	 *
	 * 用于在当前 turn 后请求优雅停止，例如在上下文即将满时。
	 *
	 * 约定：不得抛出或 reject；抛错会中断底层 agent 循环且不产生正常事件序列。
	 */
	shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;

	/**
	 * 在 `turn_end` 之后、循环决定是否发起下一次 provider 请求之前调用。
	 * 返回替换的 context/model/thinking 状态以影响本次运行中的下一 turn。
	 * 返回 undefined 则继续使用当前 context/配置。
	 */
	prepareNextTurn?: (
		context: PrepareNextTurnContext,
	) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;

	/**
	 * 返回运行中途注入对话的 steering 消息。
	 *
	 * 在当前 assistant turn 的 tool call 执行完毕后调用，除非 `shouldStopAfterTurn` 先退出。
	 * 若有返回消息，在下一次 LLM 调用前加入上下文。
	 * 当前 assistant 消息中的 tool call 不会被跳过。
	 *
	 * 用于 agent 运行中的「转向」输入。
	 *
	 * 约定：不得抛出或 reject；无 steering 消息时返回 []。
	 */
	getSteeringMessages?: () => Promise<AgentMessage[]>;

	/**
	 * 在 agent 本应停止时返回待处理的 follow-up 消息。
	 *
	 * 在无更多 tool call、无 steering 消息时调用。
	 * 若有返回消息，加入上下文并继续下一 turn。
	 *
	 * 用于应等 agent 结束后再处理的后续消息。
	 *
	 * 约定：不得抛出或 reject；无 follow-up 时返回 []。
	 */
	getFollowUpMessages?: () => Promise<AgentMessage[]>;

	/**
	 * Tool 执行模式。
	 * - "sequential"：逐个执行 tool call
	 * - "parallel"：按序 preflight，允许的工具并发执行；
	 *   每个工具收尾后按完成顺序发出 `tool_execution_end`，
	 *   tool result 消息产物稍后在 assistant 源顺序中发出
	 *
	 * 默认："parallel"
	 */
	toolExecution?: ToolExecutionMode;

	/**
	 * 参数校验通过后、工具执行前调用。
	 *
	 * 返回 `{ block: true }` 阻止执行；循环改为发出 error tool result。
	 * hook 接收 agent abort signal，须自行响应取消。
	 */
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;

	/**
	 * 工具执行完毕、发出 `tool_execution_end` 与 tool result 消息事件之前调用。
	 *
	 * 返回 `AfterToolCallResult` 可覆盖执行结果的部分字段：
	 * - `content` 完整替换 content 数组
	 * - `details` 完整替换 details
	 * - `isError` 替换 error 标志
	 * - `terminate` 替换提前终止提示
	 *
	 * 省略字段保留原值；不做深度合并。
	 * hook 接收 agent abort signal，须自行响应取消。
	 */
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
}

/**
 * 支持 thinking/reasoning 的模型的级别。
 * 注："xhigh" 仅部分模型族支持；具体模型请用 @earendil-works/pi-ai 的 thinking-level 元数据检测。
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * 可扩展的自定义应用消息接口。
 * 应用可通过声明合并扩展：
 *
 * @example
 * ```typescript
 * declare module "@mariozechner/agent" {
 *   interface CustomAgentMessages {
 *     artifact: ArtifactMessage;
 *     notification: NotificationMessage;
 *   }
 * }
 * ```
 */
export interface CustomAgentMessages {
	// 默认为空——应用通过声明合并扩展
}

/**
 * AgentMessage：LLM 消息与自定义消息的并集。
 * 该抽象允许应用在保持类型安全及与基础 LLM 消息兼容的前提下添加自定义消息类型。
 */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

/**
 * 对外 agent 状态。
 *
 * `tools` 与 `messages` 使用 accessor，以便实现可在存储前复制所赋数组。
 */
export interface AgentState {
	/** 每次模型请求附带的 system prompt。 */
	systemPrompt: string;
	/** 后续 turn 使用的活跃模型。 */
	model: Model<any>;
	/** 后续 turn 请求的思考级别。 */
	thinkingLevel: ThinkingLevel;
	/** 可用工具。赋新数组时会复制顶层数组。 */
	set tools(tools: AgentTool<any>[]);
	get tools(): AgentTool<any>[];
	/** 对话 transcript。赋新数组时会复制顶层数组。 */
	set messages(messages: AgentMessage[]);
	get messages(): AgentMessage[];
	/**
	 * 处理 prompt 或 continuation 期间为 true。
	 *
	 * 在 await 的 `agent_end` 监听器 settle 之前保持 true。
	 */
	readonly isStreaming: boolean;
	/** 当前流式响应的部分 assistant 消息（若有）。 */
	readonly streamingMessage?: AgentMessage;
	/** 正在执行的 tool call id。 */
	readonly pendingToolCalls: ReadonlySet<string>;
	/** 最近一次失败或中止的 assistant turn 的错误消息（若有）。 */
	readonly errorMessage?: string;
}

/** 工具产生的最终或部分结果。 */
export interface AgentToolResult<T> {
	/** 返回给模型的文本或图片内容。 */
	content: (TextContent | ImageContent)[];
	/** 供日志或 UI 渲染的任意结构化 details。 */
	details: T;
	/**
	 * 提示 agent 在当前 tool batch 结束后停止。
	 * 仅当 batch 内每个已收尾 tool result 均设为 true 时才会提前终止。
	 */
	terminate?: boolean;
}

/**
 * 工具流式推送部分执行更新的回调。
 *
 * 回调作用域为当前 `execute()` 调用；tool promise settle 之后的调用会被忽略。
 */
export type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;

/** Agent 运行时使用的工具定义。 */
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
	/** UI 展示用的人类可读标签。 */
	label: string;
	/**
	 * schema 校验前对原始 tool call 参数的可选兼容层。
	 * 须返回符合 `TParameters` 的对象。
	 */
	prepareArguments?: (args: unknown) => Static<TParameters>;
	/** 执行 tool call。失败应 throw，勿在 `content` 中编码错误。 */
	execute: (
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
	/**
	 * 单工具执行模式覆盖。
	 * - "sequential"：须与其它 tool call 串行执行。
	 * - "parallel"：可与其它 tool call 并发执行。
	 *
	 * 省略时使用默认执行模式。
	 */
	executionMode?: ToolExecutionMode;
}

/** 传入底层 agent 循环的上下文快照。 */
export interface AgentContext {
	/** 请求附带的 system prompt。 */
	systemPrompt: string;
	/** 模型可见的 transcript。 */
	messages: AgentMessage[];
	/** 本次运行可用工具。 */
	tools?: AgentTool<any>[];
}

/**
 * Agent 为 UI 更新发出的事件。
 *
 * `agent_end` 是一次运行的最后事件，但对该事件 await 的 `Agent.subscribe()`
 * 监听器仍属于运行 settle 的一部分；agent 仅在这些监听器结束后才变为 idle。
 */
export type AgentEvent =
	// Agent 生命周期
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	// Turn 生命周期——一个 turn 为一次 assistant 响应及其 tool call/result
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	// 消息生命周期——user、assistant、toolResult 消息均会发出
	| { type: "message_start"; message: AgentMessage }
	// 仅流式 assistant 消息期间发出
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	// Tool 执行生命周期
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
