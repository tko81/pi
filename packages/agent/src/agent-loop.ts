/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
	type AssistantMessage,
	type Context,
	EventStream,
	streamSimple,
	type ToolResultMessage,
	validateToolArguments,
} from "@earendil-works/pi-ai/compat";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	StreamFn,
} from "./types.ts";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	void runAgentLoop(
		prompts,
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	void runAgentLoopContinue(
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

// 创建本次运行的消息集合和上下文
// 发出 Agent、轮次开始事件
// 把用户输入作为消息事件发出去
// 进入真正的模型与工具循环 runLoop()
export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

// Agent 的核心循环，负责反复执行：
// 处理用户插入的消息
// → 调用模型生成 assistant 回复
// → 执行工具调用
// → 判断是否继续
// → 处理 steering / follow-up 消息
// → 最终发出 agent_end 事件
async function runLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink, // 就是 Agent 类中 processEvents() 传入的那个回调
	streamFn?: StreamFn,
): Promise<void> {
	// 这里使用 let，因为运行过程中上下文和配置可能被替换
	let currentContext = initialContext;
	let config = initialConfig;
	// 用来避免重复发送第一次 turn_start。因为调用 runLoop() 之前，runAgentLoop() 已经发送过一次 turn_start 事件
	// 第一次循环：调用者已经发过 turn_start，这里不发
	// 第二次循环：这里发送 turn_start
	// 第三次循环：这里发送 turn_start
	let firstTurn = true;
	// Steering 消息是用户在 Agent 正在运行时追加的干预消息
	// 例如模型正在思考时，用户又输入：不要再查英文资料，只看中文资料
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// 外层循环控制 follow-up 消息。
	// Agent 原本准备结束时，会检查是否有 follow-up 消息。如果有，就重新进入内部循环；如果没有，就真正结束
	while (true) {
		// 初始为 true，保证没有 steering 消息时也会执行第一次模型调用
		let shouldRunNextTurn = true;

		// 内层循环：处理工具调用和 steering 消息
		while (shouldRunNextTurn || pendingMessages.length > 0) {
			if (!firstTurn) {
				await emit({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// 处理待注入消息
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					// 模型下一次请求可以看到的完整上下文
					currentContext.messages.push(message);
					// 本次 Agent 运行新增的消息，用于最终返回和 agent_end 事件
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			// 调用模型生成回复
			const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFn);
			// 将结果加入本次新增消息
			// streamAssistantResponse() 内部已经把新消息加入 currentContext.messages 了，所以这里不需要再加入
			newMessages.push(message);

			// 错误或取消时立即结束
			// runLoop() 处理“已经消息化的失败”，handleRunFailure() 处理“直接抛出的异常”，并把异常补成标准消息和事件。
			// 例如底层模型流正常报告失败：
			// {
			//   role: "assistant",
			//   stopReason: "error",
			//   errorMessage: "API request failed"
			// }
			// 这由 runLoop() 的错误分支处理。
			// 如果底层直接抛出：
			// throw new Error("Connection reset");
			// 异常会一路到 runWithLifecycle() 的 catch，再由 handleRunFailure() 转换成标准失败消息。
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// 检查是否包含工具调用
			const toolCalls = message.content.filter((c) => c.type === "toolCall");

			const toolResults: ToolResultMessage[] = [];
			// 每轮先假设不继续下一轮
			shouldRunNextTurn = false;
			// 如果存在工具调用
			if (toolCalls.length > 0) {
				// executeToolCalls() 返回：
				// - messages：工具执行结果消息
				// - terminate：执行工具后是否应终止循环
				const executedToolBatch = await executeToolCalls(currentContext, message, config, signal, emit);
				toolResults.push(...executedToolBatch.messages);
				shouldRunNextTurn = !executedToolBatch.terminate;

				// 将工具执行结果加入上下文和本次新增消息（tool response）
				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}
			
			// 发出当前轮次结束事件，assistant 消息是 message。如果没有工具调用，toolResults 就是空数组
			await emit({ type: "turn_end", message, toolResults });

			// 准备下一轮的上下文和配置
			const nextTurnContext = {
				message,
				toolResults,
				context: currentContext,
				newMessages,
			};

			// prepareNextTurn 是一个可选钩子，没有统一的默认业务逻辑。具体逻辑由创建或使用 Agent 的上层代码注入
			// 允许在进入下一轮之前动态调整运行环境
			const nextTurnSnapshot = await config.prepareNextTurn?.(nextTurnContext);
			if (nextTurnSnapshot) {
				currentContext = nextTurnSnapshot.context ?? currentContext;
				config = {
					...config,
					model: nextTurnSnapshot.model ?? config.model,
					reasoning:
						nextTurnSnapshot.thinkingLevel === undefined
							? config.reasoning
							: nextTurnSnapshot.thinkingLevel === "off"
								? undefined
								: nextTurnSnapshot.thinkingLevel,
				};
			}

			if (
				// 调用方通过 shouldStopAfterTurn 决定是否提前终止
				// shouldStopAfterTurn 目前只有底层 Agent Loop 接口和测试用例，Agent 类里没有提供对应的公开配置项，也没有默认业务实现
				// 没有传入，就跳过，继续检查 steering 消息
				await config.shouldStopAfterTurn?.({
					message,
					toolResults,
					context: currentContext,
					newMessages,
				})
			) {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// 获取 steering 消息
			pendingMessages = (await config.getSteeringMessages?.()) || [];
		}

		// 内层循环结束后检查 follow-up
		// 执行到这里意味着：
		// - 没有继续执行的工具调用
		// - 没有 steering 消息
		// - Agent 原本准备结束
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		// 如果存在 follow-up：
		// - 把它设置为待处理消息
		// - continue 重新进入外层循环
		// - 内层循环再处理这些消息并调用模型
		if (followUpMessages.length > 0) {
			pendingMessages = followUpMessages;
			continue;
		}

		// 没有更多消息，退出外层循环
		break;
	}

	// 发出 agent_end 事件，返回本次运行的所有消息
	await emit({ type: "agent_end", messages: newMessages });
}

/**
 * 这个函数负责完成一次 LLM 流式调用
 * Agent 内部消息
 * → 可选的上下文整理
 * → 转成 LLM 消息格式
 * → 调用模型
 * → 持续接收流式事件
 * → 更新上下文并发送 Agent 事件
 * → 返回完整 AssistantMessage
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	// 默认直接使用当前上下文中的消息。如果配置了 transformContext（hook，无默认实现，用户不传跳过），则先对消息做处理
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// Agent 内部使用 AgentMessage[]，底层 LLM 接口使用 Message[]，两者不一定完全相同
	// AgentMessage 可能包含 Agent 自己需要的信息，例如：
	// - 时间戳
	// - 错误信息
	// - 工具执行状态
	// - provider/model 信息
	// 而 Message 只需要保留 LLM API 能理解的数据
	const llmMessages = await config.convertToLlm(messages);

	// 构建 LLM 上下文
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};

	// 选择流式调用函数
	const streamFunction = streamFn || streamSimple;

	// 动态解析 API key（会过期 token 需要动态更新，每次模型请求之前重新获取，可以避免一直使用已经过期的 token）
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

	// 发起模型流式请求
	const response = await streamFunction(config.model, llmContext, {
		...config,
		apiKey: resolvedApiKey,
		signal,
	});

	// 初始化流式状态，partialMessage 保存当前正在生成的、不完整的 assistant 消息
	// addedPartial 表示这个临时消息是否已经被加入，用于避免后面重复添加最终消息
	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	// 异步遍历模型事件流
	// for await...of 可以理解为：
	// 等待下一个流事件
	// → 处理事件
	// → 再等待下一个事件
	// → 直到流结束
	// 它不像普通数组那样一次性拥有所有结果，而是边接收边处理
	for await (const event of response) {
		switch (event.type) {
			// 响应开始事件：
			// - 保存初始的部分消息
			// - 将其加入上下文末尾
			// - 标记已经加入
			// - 发出 Agent 的 message_start 事件
			case "start":
				// 谁负责产生 partial
				// OpenAI、Anthropic 等供应商的原始事件格式不同，例如可能返回 token delta、content block 或 response output item。
				// 项目中各 provider adapter 会把这些原始事件转换成统一的 AssistantMessageEvent：
				// 供应商原始流事件
				// → provider adapter
				// → AssistantMessageEvent
				// → streamAssistantResponse()
				// partial 表示“截至当前时刻已经积累出来的完整半成品消息”
				partialMessage = event.partial;
				// 只在 start 事件时 push() 一次，后续流式事件不是继续 push，而是替换数组中的最后一条消息
				context.messages.push(partialMessage);
				// 表示半成品已经占据了上下文中的最后一个位置，生成结束时，需要根据它选择“替换”还是“新增”
				// 如果已经加入过半成品，此时用最终消息替换半成品，不能再 push()，否则会重复
				addedPartial = true;
				await emit({ type: "message_start", message: { ...partialMessage } });
				break;

			// 内容流式事件：更新消息。它们分别代表：
			// - text_*：普通文本内容；
			// - thinking_*：推理内容；
			// - toolcall_*：工具调用内容；
			// - start / delta / end：某类内容开始、增量更新和结束。
			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				// 上面这些事件虽然类型不同，但处理方法相同，因此共用一个代码块。每次收到增量事件：
				// - 使用最新的 event.partial 替换局部消息；
				// - 替换上下文中的最后一条消息；
				// - 发出 message_update。
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					await emit({
						type: "message_update",
						// 保留底层事件细节，让监听器知道这次更新到底是文本、思考内容还是工具调用
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;
			
			// done 或 error：流结束
			case "done":
			case "error": {
				// 取得最终的完整消息
				// 错误通常会被编码进消息，例如：stopReason: "error", errorMessage: "请求失败"，而不是一定在这里直接抛异常
				const finalMessage = await response.result();
				// 替换或添加最终消息
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				// 如果还没有加入过半成品，则补发 message_start 事件
				if (!addedPartial) {
					await emit({ type: "message_start", message: { ...finalMessage } });
				}
				await emit({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}

	const finalMessage = await response.result();
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
	return finalMessage;
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	const hasSequentialToolCall = toolCalls.some(
		(tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
	);
	if (config.toolExecution === "sequential" || hasSequentialToolCall) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
}

type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	terminate: boolean;
};

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		let finalized: FinalizedToolCallOutcome;
		if (preparation.kind === "immediate") {
			finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			};
		} else {
			const executed = await executePreparedToolCall(preparation, signal, emit);
			finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
		}

		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		finalizedCalls.push(finalized);
		messages.push(toolResultMessage);

		if (signal?.aborted) {
			break;
		}
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(finalizedCalls),
	};
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallEntry[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			const finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			} satisfies FinalizedToolCallOutcome;
			await emitToolExecutionEnd(finalized, emit);
			finalizedCalls.push(finalized);
			if (signal?.aborted) {
				break;
			}
			continue;
		}

		finalizedCalls.push(async () => {
			const executed = await executePreparedToolCall(preparation, signal, emit);
			const finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
			await emitToolExecutionEnd(finalized, emit);
			return finalized;
		});
		if (signal?.aborted) {
			break;
		}
	}

	const orderedFinalizedCalls = await Promise.all(
		finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
	);
	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
	};
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
};

type FinalizedToolCallOutcome = {
	toolCall: AgentToolCall;
	result: AgentToolResult<any>;
	isError: boolean;
};

type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);

function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
	};
}

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			isError: true,
		};
	}

	try {
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		const validatedArgs = validateToolArguments(tool, preparedToolCall);
		if (config.beforeToolCall) {
			const beforeResult = await config.beforeToolCall(
				{
					assistantMessage,
					toolCall,
					args: validatedArgs,
					context: currentContext,
				},
				signal,
			);
			if (signal?.aborted) {
				return {
					kind: "immediate",
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				};
			}
			if (beforeResult?.block) {
				return {
					kind: "immediate",
					result: createErrorToolResult(beforeResult.reason || "Tool execution was blocked"),
					isError: true,
				};
			}
		}
		if (signal?.aborted) {
			return {
				kind: "immediate",
				result: createErrorToolResult("Operation aborted"),
				isError: true,
			};
		}
		return {
			kind: "prepared",
			toolCall,
			tool,
			args: validatedArgs,
		};
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
	const updateEvents: Promise<void>[] = [];
	let acceptingUpdates = true;

	try {
		const result = await prepared.tool.execute(
			prepared.toolCall.id,
			prepared.args as never,
			signal,
			(partialResult) => {
				if (!acceptingUpdates) return;
				updateEvents.push(
					Promise.resolve(
						emit({
							type: "tool_execution_update",
							toolCallId: prepared.toolCall.id,
							toolName: prepared.toolCall.name,
							args: prepared.toolCall.arguments,
							partialResult,
						}),
					),
				);
			},
		);
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return { result, isError: false };
	} catch (error) {
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return {
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	} finally {
		acceptingUpdates = false;
	}
}

async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
	let result = executed.result;
	let isError = executed.isError;

	if (config.afterToolCall) {
		try {
			const afterResult = await config.afterToolCall(
				{
					assistantMessage,
					toolCall: prepared.toolCall,
					args: prepared.args,
					result,
					isError,
					context: currentContext,
				},
				signal,
			);
			if (afterResult) {
				result = {
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					terminate: afterResult.terminate ?? result.terminate,
				};
				isError = afterResult.isError ?? isError;
			}
		} catch (error) {
			result = createErrorToolResult(error instanceof Error ? error.message : String(error));
			isError = true;
		}
	}

	return {
		toolCall: prepared.toolCall,
		result,
		isError,
	};
}

function createErrorToolResult(message: string): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
}

function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		content: finalized.result.content,
		details: finalized.result.details,
		isError: finalized.isError,
		timestamp: Date.now(),
	};
}

async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}
