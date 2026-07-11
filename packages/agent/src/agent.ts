import {
	type ImageContent,
	type Message,
	type Model,
	type SimpleStreamOptions,
	streamSimple,
	type TextContent,
	type ThinkingBudgets,
	type Transport,
} from "@earendil-works/pi-ai/compat";
import { runAgentLoop, runAgentLoopContinue } from "./agent-loop.ts";
import type {
	AfterToolCallContext,
	AfterToolCallResult,
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentLoopTurnUpdate,
	AgentMessage,
	AgentState,
	AgentTool,
	BeforeToolCallContext,
	BeforeToolCallResult,
	PrepareNextTurnContext,
	QueueMode,
	StreamFn,
	ToolExecutionMode,
} from "./types.ts";

export type { QueueMode } from "./types.ts";

// 默认的转换函数，用于将 AgentMessage 转换为 Message 数组
function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	// 过滤掉非用户、助手或工具结果的消息
	return messages.filter(
		(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	);
}

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const DEFAULT_MODEL = {
	id: "unknown",
	name: "unknown",
	api: "unknown",
	provider: "unknown",
	baseUrl: "",
	reasoning: false,
	input: [],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 0,
	maxTokens: 0,
} satisfies Model<any>;

// Omit 删掉只读约束，再加可变类型——对外只读、对内可改，TypeScript 常见写法
// get state() 返回的仍是只读语义（实际仍是同一对象，但类型上外部不应依赖可变性）
type MutableAgentState = Omit<AgentState, "isStreaming" | "streamingMessage" | "pendingToolCalls" | "errorMessage"> & {
	isStreaming: boolean;
	streamingMessage?: AgentMessage;
	pendingToolCalls: Set<string>;
	errorMessage?: string;
};

// 工厂函数，它的核心作用是创建一个可变的、符合 AgentState Interface 的初始状态对象。它是整个 Agent 状态管理的“起点”
// 你可以把它想象成一个“状态初始化器”——就像一个游戏开始前，根据你的存档（initialState）创建一个新的游戏存档对象，但有些数据（比如是否正在运行）由系统强制重置
// 用 initialState 提供的值覆盖默认值；对于未提供的字段，使用合理的默认值；对数组字段做浅拷贝（slice()）防止外部污染。
function createMutableAgentState(
	// Partial<...>	把括号内的类型所有属性变成可选
	initialState?: Partial<Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">>,
): MutableAgentState {

	let tools = initialState?.tools?.slice() ?? [];
	let messages = initialState?.messages?.slice() ?? [];

	return {
		systemPrompt: initialState?.systemPrompt ?? "",
		model: initialState?.model ?? DEFAULT_MODEL,
		thinkingLevel: initialState?.thinkingLevel ?? "off",
		get tools() {
			return tools;
		},
		set tools(nextTools: AgentTool<any>[]) {
			tools = nextTools.slice();
		},
		get messages() {
			return messages;
		},
		set messages(nextMessages: AgentMessage[]) {
			messages = nextMessages.slice();
		},
		isStreaming: false,
		streamingMessage: undefined,
		pendingToolCalls: new Set<string>(),
		errorMessage: undefined,
	};
}

/** Options for constructing an {@link Agent}. */
// Agent 类的构造函数需要的 options，它定义了创建 AI 代理实例时可以传入的所有配置参数，这个接口设计得非常全面
// 涵盖了从核心行为（模型、系统提示）到扩展机制（钩子函数、工具调用）再到运行时控制（流式处理、重试）的方方面面
// AgentOptions 是 Agent 的“配置清单”。它像一张可定制的控制面板，让你在创建 Agent 时
// 可以精细地控制它如何与 LLM 交互、如何处理工具调用、如何管理对话流程
export interface AgentOptions {
	// 初始状态，用于覆盖默认值
	initialState?: Partial<Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">>;
	// 消息转换函数。将代理内部的 AgentMessage 数组转换为 LLM API 所需的 Message 格式（比如 OpenAI 的 { role, content } 格式）。支持异步
	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	// 上下文转换函数。在消息发送给 LLM 之前，对消息列表进行最后的修改或过滤。比如可以插入系统提示、压缩长对话等
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	// 流式函数。定义了如何与 LLM 进行流式交互（即逐块返回响应）。通常由适配器（如 OpenAI 适配器）提供
	streamFn?: StreamFn;
	// API 密钥获取函数。在需要调用 LLM API 时，通过此函数动态获取密钥。支持同步或异步，便于集成各种密钥管理方案（如环境变量、密钥托管服务）
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	// 流式载荷回调。在流式响应过程中，每当接收到一个数据块（payload）时调用。可用于实时更新 UI 或处理中间结果
	onPayload?: SimpleStreamOptions["onPayload"];
	// 流式响应回调。在流式响应完成时调用，可用于记录完整响应或执行收尾逻辑
	onResponse?: SimpleStreamOptions["onResponse"];
	// 工具调用前钩子。在代理执行任何工具之前调用。可以用于：验证权限、修改工具参数、甚至跳过工具执行（返回自定义结果）
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
	// 工具调用后钩子。在工具执行完成后调用。可以用于：处理工具结果、记录日志、修改返回给 LLM 的消息
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
	// 下一轮准备函数（无上下文版）。在每一轮对话开始前调用，可用于动态调整 Agent 状态（比如重置某些标志）
	prepareNextTurn?: (
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	// 下一轮准备函数（带上下文版，包含当前消息、历史等），便于做更精细的控制
	prepareNextTurnWithContext?: (
		context: PrepareNextTurnContext,
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	// 会话 ID。用于标识一次对话会话，可用于恢复历史记录或关联多个请求
	sessionId?: string;
	thinkingBudgets?: ThinkingBudgets;
	transport?: Transport;
	maxRetryDelayMs?: number;
	// 工具执行模式。控制工具的执行方式（比如并行执行、串行执行、或需要用户确认）
	toolExecution?: ToolExecutionMode;
}

// 这是一个消息队列管理类，它的核心作用是按特定策略存储和分发待处理的消息
// 它解决了一个很实际的问题：在AI代理系统中，消息可能以不同的速率产生，而处理端（比如LLM）只能一个一个地消费，所以需要一个缓冲区来协调生产和消费的速度。
class PendingMessageQueue {
	// 用一个数组 messages 暂存所有待处理的消息
	private messages: AgentMessage[] = [];
	// all: 一次性取出所有待处理消息	批量处理：比如在流式结束时，一次性处理所有排队消息。
	// one-at-a-time: 每次只取出一条消息（FIFO）	逐个处理：比如在循环中逐条消费消息，保证处理顺序和流控
	public mode: QueueMode;

	constructor(mode: QueueMode) {
		this.mode = mode;
	}

	enqueue(message: AgentMessage): void {
		this.messages.push(message);
	}

	hasItems(): boolean {
		return this.messages.length > 0;
	}

	drain(): AgentMessage[] {
		// 模式为 "all"：取出所有消息，然后清空队列
		if (this.mode === "all") {
			const drained = this.messages.slice();
			this.messages = [];
			return drained;
		}

		// 模式为 "one-at-a-time"：取出队列中的第一条消息，然后删除该消息
		const first = this.messages[0];
		if (!first) {
			return [];
		}
		// 删除队列中的第一条消息
		this.messages = this.messages.slice(1);
		return [first];
	}

	clear(): void {
		this.messages = [];
	}
}

// Agent 类用来记录“当前正在处理的一轮 agent 运行”
// ActiveRun 是 Agent 当前运行生命周期的句柄，负责“互斥、取消、等待空闲”这三件事：
// 1. 防止并发运行：在 prompt() 和 continue() 里都会先检查 this.activeRun。
// 如果已经有运行中的任务，就直接抛错，避免两个 prompt 同时改同一份对话状态。
// 2. 提供取消能力：当前这一轮运行的统一取消信号
// 3. 提供统一等待机制：waitForIdle() 等待当前轮结束。
type ActiveRun = {
	promise: Promise<void>; // 当前轮运行的 Promise，resolve 时表示运行结束
	resolve: () => void; // finishRun() 时手动通知“已空闲”
	abortController: AbortController; // 给当前 agent loop 和监听器传播取消信号，AbortController 是 Node.js 源码中的类，用于创建和管理取消信号
};

/**
 * Stateful wrapper around the low-level agent loop.
 * 
 * `Agent` owns the current transcript, emits lifecycle events, executes tools,
 * and exposes queueing APIs for steering and follow-up messages.
 * 
 * 底层 Agent 循环的有状态包装器
 * Agent 拥有当前的对话记录（transcript），发出生命周期事件，执行工具
 * 并暴露用于 steering 和 follow-up 消息的队列化 API
 */
export class Agent {
	private _state: MutableAgentState;
	private readonly listeners = new Set<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void>();
	private readonly steeringQueue: PendingMessageQueue;
	private readonly followUpQueue: PendingMessageQueue;
	public convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	public transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	public streamFn: StreamFn;
	public getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	public onPayload?: SimpleStreamOptions["onPayload"];
	public onResponse?: SimpleStreamOptions["onResponse"];
	public beforeToolCall?: (
		context: BeforeToolCallContext,
		signal?: AbortSignal,
	) => Promise<BeforeToolCallResult | undefined>;
	public afterToolCall?: (
		context: AfterToolCallContext,
		signal?: AbortSignal,
	) => Promise<AfterToolCallResult | undefined>;
	public prepareNextTurn?: (
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	public prepareNextTurnWithContext?: (
		context: PrepareNextTurnContext,
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	private activeRun?: ActiveRun;
	public sessionId?: string;
	public thinkingBudgets?: ThinkingBudgets;
	public transport: Transport;
	public maxRetryDelayMs?: number;
	public toolExecution: ToolExecutionMode;

	constructor(options: AgentOptions = {}) {
		this._state = createMutableAgentState(options.initialState);
		this.convertToLlm = options.convertToLlm ?? defaultConvertToLlm;
		this.transformContext = options.transformContext;
		this.streamFn = options.streamFn ?? streamSimple;
		this.getApiKey = options.getApiKey;
		this.onPayload = options.onPayload;
		this.onResponse = options.onResponse;
		this.beforeToolCall = options.beforeToolCall;
		this.afterToolCall = options.afterToolCall;
		this.prepareNextTurn = options.prepareNextTurn;
		this.prepareNextTurnWithContext = options.prepareNextTurnWithContext;
		this.steeringQueue = new PendingMessageQueue(options.steeringMode ?? "one-at-a-time");
		this.followUpQueue = new PendingMessageQueue(options.followUpMode ?? "one-at-a-time");
		this.sessionId = options.sessionId;
		this.thinkingBudgets = options.thinkingBudgets;
		this.transport = options.transport ?? "auto";
		this.maxRetryDelayMs = options.maxRetryDelayMs;
		this.toolExecution = options.toolExecution ?? "parallel";
	}

	// Agent 的事件订阅接口。外部模块可以监听 Agent 运行期间产生的生命周期事件，并返回一个函数用于取消订阅
	// event：Agent 当前触发的事件，例如开始输出、消息更新、工具调用、agent_end 等。
	// signal：当前这次 Agent 运行的取消信号。调用 agent.abort() 后，它的 aborted 会变成 true
	// 监听器既可以同步，也可以异步，项目中的 processEvents() 会按照订阅顺序逐个执行，并且 await 每个监听器。因此不是并行执行
	subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Current agent state.
	 *
	 * Assigning `state.tools` or `state.messages` copies the provided top-level array.
	 */
	get state(): AgentState {
		return this._state;
	}

	/** Controls how queued steering messages are drained. */
	set steeringMode(mode: QueueMode) {
		this.steeringQueue.mode = mode;
	}

	get steeringMode(): QueueMode {
		return this.steeringQueue.mode;
	}

	/** Controls how queued follow-up messages are drained. */
	set followUpMode(mode: QueueMode) {
		this.followUpQueue.mode = mode;
	}

	get followUpMode(): QueueMode {
		return this.followUpQueue.mode;
	}

	/** Queue a message to be injected after the current assistant turn finishes. */
	steer(message: AgentMessage): void {
		this.steeringQueue.enqueue(message);
	}

	/** Queue a message to run only after the agent would otherwise stop. */
	followUp(message: AgentMessage): void {
		this.followUpQueue.enqueue(message);
	}

	/** Remove all queued steering messages. */
	// 清空待 steering 的消息队列
	clearSteeringQueue(): void {
		this.steeringQueue.clear();
	}

	/** Remove all queued follow-up messages. */
	// 清空待 follow-up 的消息队列
	clearFollowUpQueue(): void {
		this.followUpQueue.clear();
	}

	/** Remove all queued steering and follow-up messages. */
	// 清空所有待处理的消息队列
	clearAllQueues(): void {
		this.clearSteeringQueue();
		this.clearFollowUpQueue();
	}

	/** Returns true when either queue still contains pending messages. */
	// 返回 true：当两个队列中任一队列还有未处理的消息时
	hasQueuedMessages(): boolean {
		return this.steeringQueue.hasItems() || this.followUpQueue.hasItems();
	}

	/** Active abort signal for the current run, if any. */
	get signal(): AbortSignal | undefined {
		return this.activeRun?.abortController.signal;
	}

	/** Abort the current run, if one is active. */
	abort(): void {
		this.activeRun?.abortController.abort();
	}

	// 等待 Agent 当前任务以及所有异步事件监听器执行完成
	// 返回一个 Promise，但完成后没有具体数据。调用者关心的只是“Agent 是否已经空闲”
	waitForIdle(): Promise<void> {
		// 如果 activeRun 存在，返回当前运行对应的 promise，这个 Promise 会在 finishRun() 中完成，调用 resolve() 后，所有等待 waitForIdle() 的代码都会继续执行
		// 如果 activeRun 不存在，返回 undefined，返回一个已经完成的 Promise，这样调用者可以立即继续执行后续代码
		// ?? 是空值合并运算符。当左侧为 null 或 undefined 时，使用右侧结果
		return this.activeRun?.promise ?? Promise.resolve();
	}

	/** Clear transcript state, runtime state, and queued messages. */
	reset(): void {
		this._state.messages = [];
		this._state.isStreaming = false;
		this._state.streamingMessage = undefined;
		this._state.pendingToolCalls = new Set<string>();
		this._state.errorMessage = undefined;
		this.clearFollowUpQueue();
		this.clearSteeringQueue();
	}

	/** Start a new prompt from text, a single message, or a batch of messages. */
	// 允许传入一条或多条已经构造好的 Agent 消息
	// await agent.prompt([
	// 	{ role: "user", content: "第一条消息" },
	// 	{ role: "user", content: "第二条消息" }
	// ]);
	async prompt(message: AgentMessage | AgentMessage[]): Promise<void>;

	// 允许直接传入文字，并可选地附带图片
	// 这是更方便的调用形式，内部会把字符串和图片转换成标准的 AgentMessage
	// images 只和字符串输入一起使用，不能和 AgentMessage 一起传入，因为 AgentMessage 本身已经是完整的结构化消息，其中的 content 可以直接包含 ImageContent
	async prompt(input: string, images?: ImageContent[]): Promise<void>;

	// 这是前两个重载共用的真正实现，主要分三步
	async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
		// 1. 检查是否已有运行中的任务（防止同一个 Agent 同时运行两个 prompt）。如果有，抛错提示“请先等待完成”
		if (this.activeRun) {
			throw new Error(
				"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
			);
		}
		// 2. 统一输入格式。调用者可以传字符串、单条消息或消息数组，但后面的运行逻辑希望拿到统一的消息数组。因此这里负责标准化，大致相当于：
		// "你好"
		//     → [userMessage("你好")]
		// AgentMessage
		//     → [AgentMessage]
		// AgentMessage[]
		//     → AgentMessage[]
		const messages = this.normalizePromptInput(input, images);
		// 启动 Agent 运行
		await this.runPromptMessages(messages);
	}

	/** Continue from the current transcript. The last message must be a user or tool-result message. */
	async continue(): Promise<void> {
		if (this.activeRun) {
			throw new Error("Agent is already processing. Wait for completion before continuing.");
		}

		const lastMessage = this._state.messages[this._state.messages.length - 1];
		if (!lastMessage) {
			throw new Error("No messages to continue from");
		}

		if (lastMessage.role === "assistant") {
			const queuedSteering = this.steeringQueue.drain();
			if (queuedSteering.length > 0) {
				await this.runPromptMessages(queuedSteering, { skipInitialSteeringPoll: true });
				return;
			}

			const queuedFollowUps = this.followUpQueue.drain();
			if (queuedFollowUps.length > 0) {
				await this.runPromptMessages(queuedFollowUps);
				return;
			}

			throw new Error("Cannot continue from message role: assistant");
		}

		await this.runContinuation();
	}

	// 把 prompt() 支持的三种输入形式，统一转换为 AgentMessage[]，方便后续代码只处理一种数据结构
	// 输入可以是：
	// string：普通文本
	// AgentMessage：一条结构化消息
	// AgentMessage[]：多条结构化消息
	// images：文本输入附带的图片
	// 输出始终是：AgentMessage[]
	private normalizePromptInput(
		input: string | AgentMessage | AgentMessage[],
		images?: ImageContent[],
	): AgentMessage[] {
		// 1. 输入已经是消息数组，已经满足后续需要的 AgentMessage[] 格式，所以直接返回，不再加工。
		// 需要注意：这里返回的是原数组，不会复制数组，也不会处理 images 参数。
		if (Array.isArray(input)) {
			return input;
		}

		// 2. 输入是单条结构化消息 AgentMessage -> [AgentMessage]
		if (typeof input !== "string") {
			return [input];
		}

		// 为什么AgentMessage | AgentMessage[]不处理 images
		// 因为 AgentMessage 本身已经是完整的结构化消息，其中的 content 可以直接包含 ImageContent
		// 只有字符串输入缺少承载图片的结构，所以才需要单独的 images 参数帮它组装消息
		// 从 prompt() 的公开重载也能看出这个设计

		// 3. 输入是字符串，首先将普通字符串包装成文本内容对象。
		const content: Array<TextContent | ImageContent> = [{ type: "text", text: input }];
		// 4. 把图片追加到内容中
		if (images && images.length > 0) {
			// ...images 是展开语法，表示将图片数组里的每个元素依次加入 content
			content.push(...images);
		}
		// 5. 构造用户消息，最终将内容包装成一条完整的用户消息，再放进数组中返回
		return [{ role: "user", content, timestamp: Date.now() }];
	}

	// runPromptMessages() 是 Agent 类与底层 runAgentLoop() 之间的适配层
	// 负责准备上下文、配置、事件处理、取消信号和流式函数，并通过 runWithLifecycle() 保证整次运行正确开始和结束
	private async runPromptMessages(
		messages: AgentMessage[],
		// skipInitialSteeringPoll 会继续传给 createLoopConfig(options)。
		// 结合项目语义，它表示是否跳过 Agent 主循环启动时第一次获取 steering 消息的操作：
		// false 或未设置：启动主循环时允许先检查待处理的 steering 消息。
		// true：跳过首次检查，直接开始处理当前传入的 messages。
		options: { skipInitialSteeringPoll?: boolean } = {},
	): Promise<void> {
		// 调用 runWithLifecycle()，把实际的 Agent 推理循环 runAgentLoop() 包装进来
		await this.runWithLifecycle(async (signal) => {
			// 实际执行 Agent 推理循环
			await runAgentLoop(
				messages,
				// 创建当前 Agent 上下文的快照，通常包括已有消息、模型配置、系统提示词以及其他运行所需状态。
				// 之所以创建“快照”，是为了让这一次运行使用相对稳定的上下文，而不是在运行过程中到处直接读取可变的 Agent 状态
				this.createContextSnapshot(),
				// 创建当前 Agent 的运行配置，包括模型选择、推理模式、会话 ID、事件回调等
				this.createLoopConfig(options),
				// 当 runAgentLoop() 产生事件时，通过这个回调交回 Agent，事件可能涉及消息开始、流式内容更新、工具调用和运行结束等
				// 这些事件会通过 processEvents() 方法处理，更新 Agent 内部状态，并调用 listeners 中订阅的回调函数
				(event) => this.processEvents(event),
				// 传递取消信号，用于在运行过程中取消任务
				signal,
				// 这是执行模型流式请求的函数。runAgentLoop() 通过它和模型层交互，并逐步获得模型输出，而不是等整段响应全部生成后再一次性返回
				this.streamFn,
			);
		});
	}

	private async runContinuation(): Promise<void> {
		await this.runWithLifecycle(async (signal) => {
			await runAgentLoopContinue(
				this.createContextSnapshot(),
				this.createLoopConfig(),
				(event) => this.processEvents(event),
				signal,
				this.streamFn,
			);
		});
	}

	private createContextSnapshot(): AgentContext {
		return {
			systemPrompt: this._state.systemPrompt,
			messages: this._state.messages.slice(),
			tools: this._state.tools.slice(),
		};
	}

	private createLoopConfig(options: { skipInitialSteeringPoll?: boolean } = {}): AgentLoopConfig {
		let skipInitialSteeringPoll = options.skipInitialSteeringPoll === true;
		return {
			model: this._state.model,
			reasoning: this._state.thinkingLevel === "off" ? undefined : this._state.thinkingLevel,
			sessionId: this.sessionId,
			onPayload: this.onPayload,
			onResponse: this.onResponse,
			transport: this.transport,
			thinkingBudgets: this.thinkingBudgets,
			maxRetryDelayMs: this.maxRetryDelayMs,
			toolExecution: this.toolExecution,
			beforeToolCall: this.beforeToolCall,
			afterToolCall: this.afterToolCall,
			prepareNextTurn:
				this.prepareNextTurnWithContext || this.prepareNextTurn
					? async (context) => {
							if (this.prepareNextTurnWithContext) {
								return await this.prepareNextTurnWithContext(context, this.signal);
							}
							return await this.prepareNextTurn?.(this.signal);
						}
					: undefined,
			convertToLlm: this.convertToLlm,
			transformContext: this.transformContext,
			getApiKey: this.getApiKey,
			getSteeringMessages: async () => {
				if (skipInitialSteeringPoll) {
					skipInitialSteeringPoll = false;
					return [];
				}
				return this.steeringQueue.drain();
			},
			getFollowUpMessages: async () => this.followUpQueue.drain(),
		};
	}

	/* 
	这个方法是 Agent 一次运行的“生命周期管理器”，负责：
	- 防止重复运行
	- 建立 activeRun
	- 提供取消信号
	- 设置运行状态
	- 执行具体任务
	- 统一处理异常
	- 无论成功失败都清理现场
	runWithLifecycle() 管生命周期，executor() 管具体工作
	executor() 内部再调用 runAgentLoop() 执行实际的 Agent 推理循环
	*/
	private async runWithLifecycle(executor: (signal: AbortSignal) => Promise<void>): Promise<void> {
		// 只要 activeRun 存在，就表示这个 Agent 正在处理任务，不能再启动另一个任务
		if (this.activeRun) {
			throw new Error("Agent is already processing.");
		}

		// 创建一个 AbortController，用于在运行过程中取消任务
		const abortController = new AbortController();
		// 创建一个空函数
		let resolvePromise = () => {};
		// 创建一个 promise，供外部通过 waitForIdle() 函数等待，并把这个 promise 的 resolve 函数
		// 赋值给 resolvePromise，这样当 Agent 运行结束时，就可以用 resolvePromise() 来完成这个 promise，让等待中的代码继续执行
		// 见下方例子
		const promise = new Promise<void>((resolve) => {
			resolvePromise = resolve;
		});
		this.activeRun = { promise, resolve: resolvePromise, abortController };

		// 表示 Agent 已进入运行或流式生成状态
		this._state.isStreaming = true;
		// 清除上一次运行可能遗留的流式消息
		this._state.streamingMessage = undefined;
		// 清除上一次运行可能遗留的错误消息
		this._state.errorMessage = undefined;

		try {
			// executor 通常会调用 runAgentLoop() 执行实际的 Agent 推理循环
			// 使用 await 意味着生命周期管理器会等待：
			// - 模型输出
			// - 工具调用
			// - Agent 循环
			// - 事件处理
			// - 异步事件监听器
			// 全部完成后，才离开 try
			await executor(abortController.signal);
		} catch (error) {
			// 如果执行过程中发生错误，调用 handleRunFailure() 处理
			// 这个方法会发送一个失败消息，并调用 processEvents() 通知 listeners
			await this.handleRunFailure(error, abortController.signal.aborted);
		} finally {
			// 无论成功失败，最后都要调用 finishRun() 清理运行状态
			// 确保无论什么情况下，Agent 都能正确进入空闲状态
			this.finishRun();
		}
	}

	/* 	
	let openDoor = () => {};

	const doorOpened = new Promise<void>((resolve) => {
		openDoor = resolve;
	});

	async function waitOutside() {
		console.log("等待开门");
		await doorOpened;
		console.log("门开了");
	}

	waitOutside();

	setTimeout(() => {
		openDoor();
	}, 2000); 
	
	输出：
	等待开门
	等待 2 秒
	门开了
	*/

	// 把异常或取消转换成一套标准事件
	// 整体的异常流程：
	// runAgentLoop 抛出异常
	//         ↓
	// handleRunFailure()
	//         ↓
	// 生成失败消息
	//         ↓
	// 依次模拟完整的结束事件
	//         ↓
	// processEvents() 更新状态并通知监听器
	//         ↓
	// finishRun()
	//         ↓
	// Agent 回到 idle
	private async handleRunFailure(error: unknown, aborted: boolean): Promise<void> {
		const failureMessage = {
			// 表示这是本次 Agent 响应的结果消息
			role: "assistant",
			// 失败时通常没有正常生成的文本，但消息结构仍然要求有 content，所以放入空文本
			content: [{ type: "text", text: "" }],
			// 记录发生错误时使用的模型信息，方便展示、日志记录和排查问题
			api: this._state.model.api,
			provider: this._state.model.provider,
			model: this._state.model.id,
			// 失败时没有可靠的 token 用量，因此使用项目定义的空用量对象
			usage: EMPTY_USAGE,
			// 记录停止原因：用户主动取消或执行过程中发生错误
			stopReason: aborted ? "aborted" : "error",
			// 记录错误的具体信息，方便排查问题
			errorMessage: error instanceof Error ? error.message : String(error),
			timestamp: Date.now(),
		} satisfies AgentMessage; // 检查这个对象属性是否符合或包含 AgentMessage，但不会把变量强制转换成宽泛的 AgentMessage 类型
		// 模拟完整的失败事件流程
		await this.processEvents({ type: "message_start", message: failureMessage });
		await this.processEvents({ type: "message_end", message: failureMessage });
		await this.processEvents({ type: "turn_end", message: failureMessage, toolResults: [] });
		await this.processEvents({ type: "agent_end", messages: [failureMessage] });
	}

	private finishRun(): void {
		this._state.isStreaming = false;
		this._state.streamingMessage = undefined;
		this._state.pendingToolCalls = new Set<string>();
		this.activeRun?.resolve();
		this.activeRun = undefined;
	}

	/**
	 * Reduce internal state for a loop event, then await listeners.
	 *
	 * `agent_end` only means no further loop events will be emitted. The run is
	 * considered idle later, after all awaited listeners for `agent_end` finish
	 * and `finishRun()` clears runtime-owned state.
	 */
	// 根据事件更新 Agent 内部状态
	// 依次调用所有通过 subscribe() 注册的监听器
	// 这里采用的是一种 reducer 风格：旧状态 + 事件 → 新状态
	private async processEvents(event: AgentEvent): Promise<void> {
		// processEvents() 的 switch 只负责“需要修改 Agent 内部状态”的事件，而不是要求覆盖全部事件
		// 但所有事件都会通知监听器，因为它们都可能影响 UI 状态
		switch (event.type) {
			// 模型开始生成一条消息时，把它保存为当前流式消息。UI 可以根据它展示“正在生成”的回复
			case "message_start":
				this._state.streamingMessage = event.message;
				break;

			// 收到新的流式内容时，用最新消息替换之前的 streamingMessage
			case "message_update":
				this._state.streamingMessage = event.message;
				break;

			// 消息生成完成后：清除临时的流式消息，将最终消息加入正式历史记录
			case "message_end":
				this._state.streamingMessage = undefined;
				this._state.messages.push(event.message);
				break;

			// 工具开始执行时，将工具调用 ID 加入待处理集合
			case "tool_execution_start": {
				// 更新 Set 时，不直接修改原来的对象，而是创建一个新 Set，修改新对象后再赋回状态
				// this._state.pendingToolCalls.add(event.toolCallId); 这种写法中，Set 里的内容变了，但对象引用没有变
				// 一些 UI 状态系统会通过引用是否改变来判断需不需要刷新，因为直接 .add() 后引用没变，UI 可能无法发现更新
				const pendingToolCalls = new Set(this._state.pendingToolCalls);
				pendingToolCalls.add(event.toolCallId);
				this._state.pendingToolCalls = pendingToolCalls;
				break;
			}

			// 工具执行结束后，将对应 ID 从待处理集合删除
			case "tool_execution_end": {
				const pendingToolCalls = new Set(this._state.pendingToolCalls);
				pendingToolCalls.delete(event.toolCallId);
				this._state.pendingToolCalls = pendingToolCalls;
				break;
			}

			// 一个对话轮次结束时，如果 assistant 消息包含错误，就把错误保存到 Agent 状态
			case "turn_end":
				if (event.message.role === "assistant" && event.message.errorMessage) {
					this._state.errorMessage = event.message.errorMessage;
				}
				break;

			// 整个 Agent 循环结束，确保不再保留流式消息
			case "agent_end":
				this._state.streamingMessage = undefined;
				break;
		}
		// 状态更新之后，方法会取得当前运行的取消信号
		const signal = this.activeRun?.abortController.signal;
		// 这是一个内部一致性检查。processEvents() 应该只在一次有效的 Agent 运行中调用，因为监听器需要收到当前运行对应的 AbortSignal
		if (!signal) {
			throw new Error("Agent listener invoked outside active run");
		}
		// 串行按订阅顺序执行监听器
		for (const listener of this.listeners) {
			await listener(event, signal);
		}
	}
}
