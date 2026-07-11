import Anthropic from "@anthropic-ai/sdk";
import type {
	CacheControlEphemeral,
	ContentBlockParam,
	MessageCreateParamsStreaming,
	MessageParam,
	RawMessageStreamEvent,
	RefusalStopDetails,
} from "@anthropic-ai/sdk/resources/messages.js";
import { calculateCost } from "../models.ts";
import type {
	AnthropicMessagesCompat,
	Api,
	AssistantMessage,
	CacheRetention,
	Context,
	ImageContent,
	Message,
	Model,
	ProviderEnv,
	ProviderHeaders,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { parseJsonWithRepair, parseStreamingJson } from "../utils/json-parse.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";

import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.ts";
import { adjustMaxTokensForThinking, buildBaseOptions, clampMaxTokensToContext } from "./simple-options.ts";
import { transformMessages } from "./transform-messages.ts";

/**
 * Resolve cache retention preference.
 * Defaults to "short" and uses PI_CACHE_RETENTION for backward compatibility.
 */
function resolveCacheRetention(cacheRetention?: CacheRetention, env?: ProviderEnv): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (getProviderEnvValue("PI_CACHE_RETENTION", env) === "long") {
		return "long";
	}
	return "short";
}

function getCacheControl(
	model: Model<"anthropic-messages">,
	cacheRetention?: CacheRetention,
	env?: ProviderEnv,
): { retention: CacheRetention; cacheControl?: CacheControlEphemeral } {
	const retention = resolveCacheRetention(cacheRetention, env);
	if (retention === "none") {
		return { retention };
	}
	const ttl = retention === "long" && getAnthropicCompat(model).supportsLongCacheRetention ? "1h" : undefined;
	return {
		retention,
		cacheControl: { type: "ephemeral", ...(ttl && { ttl }) },
	};
}

// Stealth mode: Mimic Claude Code's tool naming exactly
const claudeCodeVersion = "2.1.75";

// Claude Code 2.x tool names (canonical casing)
// Source: https://cchistory.mariozechner.at/data/prompts-2.1.11.md
// To update: https://github.com/badlogic/cchistory
const claudeCodeTools = [
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Grep",
	"Glob",
	"AskUserQuestion",
	"EnterPlanMode",
	"ExitPlanMode",
	"KillShell",
	"NotebookEdit",
	"Skill",
	"Task",
	"TaskOutput",
	"TodoWrite",
	"WebFetch",
	"WebSearch",
];

const ccToolLookup = new Map(claudeCodeTools.map((t) => [t.toLowerCase(), t]));

// Convert tool name to CC canonical casing if it matches (case-insensitive)
const toClaudeCodeName = (name: string) => ccToolLookup.get(name.toLowerCase()) ?? name;
const fromClaudeCodeName = (name: string, tools?: Tool[]) => {
	if (tools && tools.length > 0) {
		const lowerName = name.toLowerCase();
		const matchedTool = tools.find((tool) => tool.name.toLowerCase() === lowerName);
		if (matchedTool) return matchedTool.name;
	}
	return name;
};

/**
 * Convert content blocks to Anthropic API format
 */
function convertContentBlocks(content: (TextContent | ImageContent)[]):
	| string
	| Array<
			| { type: "text"; text: string }
			| {
					type: "image";
					source: {
						type: "base64";
						media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
						data: string;
					};
			  }
	  > {
	// If only text blocks, return as concatenated string for simplicity
	const hasImages = content.some((c) => c.type === "image");
	if (!hasImages) {
		return sanitizeSurrogates(content.map((c) => (c as TextContent).text).join("\n"));
	}

	// If we have images, convert to content block array
	const blocks = content.map((block) => {
		if (block.type === "text") {
			return {
				type: "text" as const,
				text: sanitizeSurrogates(block.text),
			};
		}
		return {
			type: "image" as const,
			source: {
				type: "base64" as const,
				media_type: block.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
				data: block.data,
			},
		};
	});

	// If only images (no text), add placeholder text block
	const hasText = blocks.some((b) => b.type === "text");
	if (!hasText) {
		blocks.unshift({
			type: "text" as const,
			text: "(see attached image)",
		});
	}

	return blocks;
}

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type AnthropicThinkingDisplay = "summarized" | "omitted";

const FINE_GRAINED_TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";

function getAnthropicCompat(
	model: Model<"anthropic-messages">,
): Required<Omit<AnthropicMessagesCompat, "forceAdaptiveThinking">> {
	return {
		supportsEagerToolInputStreaming: model.compat?.supportsEagerToolInputStreaming ?? true,
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
		sendSessionAffinityHeaders: model.compat?.sendSessionAffinityHeaders ?? false,
		supportsCacheControlOnTools: model.compat?.supportsCacheControlOnTools ?? true,
		supportsTemperature: model.compat?.supportsTemperature ?? true,
		allowEmptySignature: model.compat?.allowEmptySignature ?? false,
	};
}

// 它继承了通用的 StreamOptions，所以同时拥有 API Key、取消信号等通用选项，以及 Claude 特有的 thinking、工具选择和客户端注入选项
export interface AnthropicOptions extends StreamOptions {

	/**
	 * 项目通过两套字段兼容不同代际的模型
	 * 旧模型：
	 * - thinkingEnabled + thinkingBudgetTokens
	 * 自适应模型：
	 * - thinkingEnabled + effort
	 */

	 /** 
	 * 控制是否启用 Claude 的扩展思考能力
	 * 启用 thinking；不传时，默认不会主动把 thinking 配置发给 Anthropic，除非 streamSimple() 根据统一的 reasoning 配置自动转换。
	 * 它对两类模型有不同作用：
	 * - 自适应思考模型：模型自己决定是否思考以及思考多少。
	 * - 较老模型：结合 thinkingBudgetTokens 限制思考 token 数量。
	 */
	thinkingEnabled?: boolean;
	/**
	 * 给较老的、基于预算的 thinking 模型设置思考 token 上限
	 * 表示最多为扩展思考分配 4096 个 token
	 * 如果 thinkingEnabled 为 true，但没有提供 thinkingBudgetTokens，则默认使用 1024 个 token
	 * 对于自适应思考模型，这个字段会被忽略，因为它们使用 effort，而不是固定 token 预算
	 */
	thinkingBudgetTokens?: number;
	/**
	 * 控制自适应思考模型投入多少推理强度
	 * 值	含义
	 * - "low"	最少推理，简单任务可能不思考
	 * - "medium"	中等推理，简单任务可能跳过
	 * - "high"	深度推理，通常会进行思考
	 * - "xhigh"	更高推理强度，仅部分模型支持
	 * - "max"	最大推理强度，仅特定模型支持
	 * effort 只对支持自适应 thinking 的模型有效，旧模型会忽略它
	 */
	effort?: AnthropicEffort;
	/**
	 * 控制 API 响应中如何返回 thinking 内容
	 * "summarized"：API 返回经过总结的思考文本，应用可以显示 thinking 内容
	 * "omitted"：thinking 块仍然存在，但文本字段为空。用于不展示思考内容的 UI，可以缩短首个正常文本 token 的等待时间。
	 * 即使文本被省略，加密签名仍然会返回并保存在消息中，以便多轮对话保持 thinking 连续性。Anthropic 不会把 Claude 的
	 * 思考文本返回给程序，但仍会返回一个不可读的加密签名，用来证明和标识本次思考状态。可以粗略理解为响应中有这样的 thinking block：
		{
		type: "thinking",
		thinking: "",                 // 思考文本被省略
		signature: "加密后的签名数据"  // 仍然保留
		}
	 * 这里的 signature 不是给人阅读的思考内容，也不能从中还原 Claude 的完整推理。它是 Anthropic API 使用的受保护数据。
	 * thinking signature 的核心作用是：让 Anthropic 验证某个 thinking block 确实是 Claude 在之前响应中生成的，并
	 * 允许该思考上下文在后续请求，特别是工具调用循环中被安全地原样带回。可以把它理解为 Claude 思考块的“防篡改凭证”
	 * 
	 * 默认值："summarized"，与旧模型保持一致（这是项目自己选择的兼容性默认值，不一定等于某些 Anthropic 模型 API 的默认值）
	 */
	thinkingDisplay?: AnthropicThinkingDisplay;
	/**
	 * 控制是否为非自适应模型启用“交错思考”。普通工具循环可能是：
	 * 集中思考
	 * → 调用工具
	 * → 读取工具结果
	 * → 输出回答
	 * 交错思考允许模型在工具调用之间继续思考
	 * 默认值：true，对于自适应 thinking 模型，这种能力已经内置，因此无论该选项是什么，都不需要发送对应的 beta header
	 * Pi Agent 的 ReAct 循环提供“工具调用之间再次请求模型”的结构
	 * Anthropic 的 interleaved thinking 允许 Claude 在这个结构里的后续轮次继续使用扩展思考
	 */
	interleavedThinking?: boolean;
	/**
	 * 控制 Claude 如何使用工具
	 * "auto"：模型自己决定是否调用工具
	 * "any"：强制使用工具，但具体使用哪个由模型决定
	 * "none"：不调用工具
	 */
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
	/**
	 * 允许调用者直接传入一个已经创建好的 Anthropic SDK 客户端，提供后，项目会跳过内部客户端创建，直接使用这个实例
	 */
	client?: Anthropic;
}

function mergeHeaders(...headerSources: (ProviderHeaders | undefined)[]): ProviderHeaders {
	const merged: ProviderHeaders = {};
	for (const headers of headerSources) {
		if (headers) {
			Object.assign(merged, headers);
		}
	}
	return merged;
}

function hasHeader(headers: ProviderHeaders | undefined, name: string): boolean {
	if (!headers) return false;
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === expected && value !== null && value.trim().length > 0) return true;
	}
	return false;
}

// 这里不仅检查 apiKey，还会考虑调用者提供的 headers，因为某些兼容服务可能把鉴权信息直接放在 header 中
// 如果既没有 API Key，也没有可接受的 header 鉴权，这里会抛出错误，避免创建一个注定不能调用 API 的 Client
function assertRequestAuth(provider: string, apiKey: string | undefined, headers: ProviderHeaders | undefined): void {
	if (apiKey) return;
	if (
		hasHeader(headers, "authorization") ||
		hasHeader(headers, "x-api-key") ||
		hasHeader(headers, "cf-aig-authorization")
	) {
		return;
	}
	throw new Error(`No API key for provider: ${provider}`);
}

interface ServerSentEvent {
	// 这是什么事件
	event: string | null;
	// 事件携带了什么内容
	data: string;
	// 服务端原本究竟发送了什么
	raw: string[];
}

interface SseDecoderState {
	event: string | null;
	data: string[];
	raw: string[];
}

const ANTHROPIC_MESSAGE_EVENTS: ReadonlySet<string> = new Set([
	"message_start",
	"message_delta",
	"message_stop",
	"content_block_start",
	"content_block_delta",
	"content_block_stop",
]);

function flushSseEvent(state: SseDecoderState): ServerSentEvent | null {
	// 如果当前事件没有名称，也没有 data 行，说明这是一个空事件，直接返回 null
	if (!state.event && state.data.length === 0) {
		return null;
	}

	// 否则，创建一个完整的 ServerSentEvent 对象，包含 event、data 和 raw 数据
	const event: ServerSentEvent = {
		event: state.event,
		data: state.data.join("\n"),
		raw: [...state.raw],
	};
	// 清空状态，准备解析下一个事件
	state.event = null;
	state.data = [];
	state.raw = [];
	return event;
}

/* 
这个函数负责解析一行 SSE 文本，并把解析结果累积到 state 中
它不会每读取一行都返回事件。只有遇到空行，表示当前 SSE 事件结束时，才返回一个完整的 ServerSentEvent
SSE 使用空行分隔事件：
event: message_start
data: {"id":"msg-1"}

event: message_stop
data: {}
第一组 event 和 data 后面的空行，表示第一条事件结束 
*/
function decodeSseLine(line: string, state: SseDecoderState): ServerSentEvent | null {
	// 空行表示事件结束，用当前 state 创建完整事件
	if (line === "") {
		return flushSseEvent(state);
	}
	// 只要不是分隔事件的空行，就把当前行保存到 raw
	state.raw.push(line);
	/* 
	忽略 SSE 注释行
	SSE 中以冒号开头的行是注释：
	: ping
	: keep-alive
	服务端常用这种行维持连接。
	它不会成为业务事件的 event 或 data，所以直接返回 null
	不过，因为 state.raw.push(line) 发生在前面，注释行仍然会保存在 raw 中
	*/
	if (line.startsWith(":")) {
		return null;
	}

	// 寻找字段名与值的分隔符
	// SSE 行通常是：字段名: 字段值。为什么只找第一个？因为值里面也可能有冒号
	// 如果没有冒号：根据 SSE 规则，整行就是字段名
	const delimiterIndex = line.indexOf(":");
	// 提取字段名
	const fieldName = delimiterIndex === -1 ? line : line.slice(0, delimiterIndex);
	// 提取字段值
	let value = delimiterIndex === -1 ? "" : line.slice(delimiterIndex + 1);
	// 如果值以空格开头，去掉空格
	if (value.startsWith(" ")) {
		value = value.slice(1);
	}

	if (fieldName === "event") {
		state.event = value;
	} else if (fieldName === "data") {
		state.data.push(value);
	}

	return null;
}

function nextLineBreakIndex(text: string): number {
	const carriageReturnIndex = text.indexOf("\r");
	const newlineIndex = text.indexOf("\n");
	if (carriageReturnIndex === -1) {
		return newlineIndex;
	}
	if (newlineIndex === -1) {
		return carriageReturnIndex;
	}
	return Math.min(carriageReturnIndex, newlineIndex);
}

function consumeLine(text: string): { line: string; rest: string } | null {
	const lineBreakIndex = nextLineBreakIndex(text);
	if (lineBreakIndex === -1) {
		return null;
	}

	let nextIndex = lineBreakIndex + 1;
	if (text[lineBreakIndex] === "\r" && text[nextIndex] === "\n") {
		nextIndex += 1;
	}

	return {
		line: text.slice(0, lineBreakIndex),
		rest: text.slice(nextIndex),
	};
}

// 从 HTTP 的 response.body 字节流中持续读取字节流，再通过 utf-8 解码器解码成文本
// 将 SSE 文本协议解析成一个个 ServerSentEvent，再通过 yield 交给调用者
async function* iterateSseMessages(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<ServerSentEvent> {
	// 获取字节流读取器
	const reader = body.getReader();
	// 创建文本解码器，默认使用 UTF-8 编码
	const decoder = new TextDecoder();
	// 初始化 SSE 解析状态，一个 SSE 事件可能由多行组成，因此不能看到一行就立即生成完整事件，需要暂存：
	// - event：当前 SSE 事件名称
	// - data：当前事件的所有 data: 行
	// - raw：当前事件未经处理的原始行
	// 空行表示一个 SSE 事件结束
	const state: SseDecoderState = { event: null, data: [], raw: [] };
	// 初始化缓冲区，网络数据块的边界不等于文本行的边界
	// 例如服务端发送：
	// data: {"text":"你好"}\n\n
	// 实际读取时可能被拆成：
	// - chunk1: data: {"tex
	// - chunk2: t":"你
	// - chunk3: 好"}\n\n
	// 因此每次解码后的文本必须先追加到 buffer：
	// buffer += decodedText;
	// 只有发现完整换行后才能解析
	let buffer = "";

	try {
		// 持续从 body 读取字节流，直到流结束、取消或发生错误
		while (true) {
			// 如果调用者已经取消请求，就抛出异常，停止解析
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}
			// 等待下一段网络数据，如果暂时没有数据，当前异步生成器会停在这里
			const { value, done } = await reader.read();
			if (done) {
				break;
			}

			// stream: true 非常重要，表示：后面还有更多字节，本次末尾如果遇到不完整的 UTF-8 字符，先不要生成错误字符，等待下一个数据块补全
			// 流式 TextDecoder 会把前两个字节暂存在内部，等第三个字节到达后再正确生成汉字
			buffer += decoder.decode(value, { stream: true });
			// 从 buffer 中逐行解析，consumeLine() 尝试从 buffer 取出一整行，如果当前 buffer 还没有完整换行，则返回 null
			let consumed = consumeLine(buffer);
			// 循环接着处理所有完整行
			while (consumed) {
				// 更新剩余缓冲区，已经取出的行从 buffer 中移除，只保留还没处理的部分
				buffer = consumed.rest;
				// 解析当前行，大多数普通行只更新 state，返回 null。只有读到事件分隔空行时，才会得到完整的 ServerSentEvent
				const event = decodeSseLine(consumed.line, state);
				// yield 会把事件交给外面的 for await，并暂时暂停生成器。调用者处理完并请求下一项后，生成器继续运行
				if (event) {
					yield event;
				}
				// 继续尝试取下一行
				consumed = consumeLine(buffer);
			}
		}

		// 网络流结束后的 Decoder 收尾，不带参数调用表示输入已经结束，把内部剩余字节全部输出并完成解码
		buffer += decoder.decode();
		// 处理收尾后的完整行，这是对剩余 buffer 再做一次正常逐行处理
		let consumed = consumeLine(buffer);
		while (consumed) {
			buffer = consumed.rest;
			const event = decodeSseLine(consumed.line, state);
			if (event) {
				yield event;
			}
			consumed = consumeLine(buffer);
		}
		// 处理没有换行的最后一行，服务端最后一行可能没有以 \n 结束
		// 这种情况下 consumeLine() 无法取出它，所以这里手动把剩余 buffer 作为最后一行解析
		if (buffer.length > 0) {
			const event = decodeSseLine(buffer, state);
			if (event) {
				yield event;
			}
		}
		// 强制提交最后一个 SSE 事件
		const trailingEvent = flushSseEvent(state);
		if (trailingEvent) {
			yield trailingEvent;
		}
	} finally {
		reader.releaseLock();
	}
}

/* 
这个函数是在上一层 iterateSseMessages() 之上，再做一层 Anthropic 协议解析。
上一层输出的是通用 SSE：
ServerSentEvent {
  event: string | null;
  data: string;
  raw: string[];
}
当前函数把它转换成 Anthropic SDK 定义的事件对象：RawMessageStreamEvent 

HTTP Response.body
        ↓
iterateSseMessages()
        ↓
通用 SSE { event, data, raw }
        ↓
过滤 Anthropic 消息事件
        ↓
JSON 解析
        ↓
RawMessageStreamEvent
        ↓
yield 给上层处理
*/
async function* iterateAnthropicEvents(
	response: Response,
	signal?: AbortSignal,
): AsyncGenerator<RawMessageStreamEvent> {
	// 检查响应体流式响应必须有：response.body，如果没有响应体，就无法读取 SSE 数据，因此立即报错
	if (!response.body) {
		throw new Error("Attempted to iterate over an Anthropic response with no body");
	}

	// 记录是否收到开始和结束事件，用来检查 Anthropic 响应是否完整
	let sawMessageStart = false;
	let sawMessageEnd = false;

	// 遍历底层 SSE
	for await (const sse of iterateSseMessages(response.body, signal)) {
		if (sse.event === "error") {
			throw new Error(sse.data);
		}
		// 过滤掉非 Anthropic 消息事件
		if (!ANTHROPIC_MESSAGE_EVENTS.has(sse.event ?? "")) {
			continue;
		}

		try {
			// 解析 JSON
			const event = parseJsonWithRepair<RawMessageStreamEvent>(sse.data);
			// 更新完整性标记
			if (event.type === "message_start") {
				sawMessageStart = true;
			} else if (event.type === "message_stop") {
				sawMessageEnd = true;
			}
			// 向上层产出事件
			yield event;
		} catch (error) {
			// 解析失败，抛出错误，包含原始事件数据，方便调试
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Could not parse Anthropic SSE event ${sse.event}: ${message}; data=${sse.data}; raw=${sse.raw.join("\\n")}`,
			);
		}
	}

	// 检查响应是否完整，必须有开始和结束事件
	if (sawMessageStart && !sawMessageEnd) {
		throw new Error("Anthropic stream ended before message_stop");
	}
}

/* 
这段 stream() 是 Anthropic Messages API 的流式适配器。它负责：
项目统一的 Model + Context
        ↓
转换并调用 Anthropic API
        ↓
接收 Anthropic 原始流事件
        ↓
逐步拼接 AssistantMessage
        ↓
转换成项目统一的 AssistantMessageEvent
        ↓
通过 AssistantMessageEventStream 返回
最关键的理解是：函数会立即返回一个事件流，真正的网络请求和消息拼接在后台异步执行。
它只接受使用 Anthropic Messages 协议的模型：model: Model<"anthropic-messages"> 

用 const 而非用 function 定义 stream(): TypeScript 会强制检查右边的函数是否完全符合 StreamFunction 这个接口
如果参数或返回值类型不匹配，立即报错。这起到“类型守卫”的作用
*/
export const stream: StreamFunction<"anthropic-messages", AnthropicOptions> = (
	model: Model<"anthropic-messages">,
	context: Context,
	options?: AnthropicOptions,
): AssistantMessageEventStream => {
	/* 
	为什么里面有一个异步立即执行函数?
	stream() 本身不是 async，所以它不会等 Anthropic 响应完成才返回
	执行顺序是：
	1. 创建 stream
    2. 启动异步后台任务
	3. 立即 return stream 
	4. 后台陆续 stream.push(event)
	5. 调用者通过 for await 消费
	调用者因此可以马上拿到事件流
	const response = stream(model, context, options);
	for await (const event of response) {
	  // 边生成边处理
	}
	如果这里直接 await 完整请求再返回，就失去了流式输出的意义。 
	*/
	const stream = new AssistantMessageEventStream();

	/* 
	立即执行函数表达式（IIFE），结合了箭头函数和异步特性
	- async () => { ... }	定义一个异步箭头函数
	- 后面的()	立即调用这个函数（IIFE 的执行括号）
	 */
	(async () => {
		// 先创建一个空的 AssistantMessage，后续收到流式数据时，持续修改这个 output
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		// 这个异步立即执行函数没有被外层 await，所以内部必须自己用 try/catch 处理错误，否则容易产生未处理的 Promise rejection
		try {
			// 创建或使用 Anthropic Client
			let client: Anthropic;
			let isOAuth: boolean;

			// 如果调用者提供了 Client 选项，直接使用它
			if (options?.client) {
				client = options.client;
				isOAuth = false;
			} else {
				// 由适配器创建 Client
				const apiKey = options?.apiKey;
				// 检查请求有没有可用的鉴权信息
				assertRequestAuth(model.provider, apiKey, options?.headers);

				// 准备 GitHub Copilot 动态请求头，只有当前模型通过 GitHub Copilot provider 调用时才会用到
				let copilotDynamicHeaders: Record<string, string> | undefined;
				// GitHub Copilot 是模型访问渠道，Anthropic Messages 是调用协议
				// 项目复用了 Anthropic SDK 和 Messages API 格式，通过 GitHub Copilot 的服务地址去调用 Copilot 提供的 Claude 模型
				// 它并不是直接请求 Anthropic 官方 API
				// Pi 项目
				// ↓ 使用 Anthropic SDK / Messages 协议
				// GitHub Copilot 服务端
				// ↓ 转发或提供
				// Claude 模型
				if (model.provider === "github-copilot") {
					// 检查消息中有没有图片
					const hasImages = hasCopilotVisionInput(context.messages);
					// 准备 GitHub Copilot 动态请求头
					copilotDynamicHeaders = buildCopilotDynamicHeaders({
						messages: context.messages,
						hasImages,
					});
				}

				// 解析缓存策略，它决定当前请求使用哪种缓存保留策略：
				// "none"  → 不使用缓存
				// "short" → 短期缓存
				// "long"  → 长期缓存
				const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);

				// 决定是否传递 sessionId，如果明确禁用缓存，就不传 session ID
				// 这个 session ID 后续可能被转换为：x-session-affinity: <sessionId>
				// 作用是让兼容 Provider 尽量把同一会话路由到相同后端，提高缓存命中或会话亲和性
				const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
				// 调用 Anthropic SDK 创建 Client
				const created = createClient(
					model,
					apiKey,
					options?.interleavedThinking ?? true,
					shouldUseFineGrainedToolStreamingBeta(model, context),
					options?.headers,
					copilotDynamicHeaders,
					cacheSessionId,
				);
				client = created.client;
				isOAuth = created.isOAuthToken;
			}
			// 构造请求参数
			// 把项目统一的 Context 转成 Anthropic Messages API 所需格式，例如：
			// context.systemPrompt → system
			// context.messages     → messages
			// context.tools        → tools
			// reasoning 配置       → thinking
			let params = buildParams(model, context, isOAuth, options);
			// 然后提供一个请求修改钩子：调用者可以在请求发送前检查或修改最终 payload
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as MessageCreateParamsStreaming;
			}
			// 请求支持：
			// - AbortSignal 取消
			// - 超时
			// - 自动重试次数
			const requestOptions = {
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				maxRetries: options?.maxRetries ?? 0,
			};
			// 发起流式请求并等待服务端返回响应状态和 headers，由于是流式请求，所以不会等待响应体完成
			// 这行代码发送一个流式请求，并等待服务端建立 SSE 响应连接
			const response = await client.messages.create({ ...params, stream: true }, requestOptions).asResponse();
			// 调用响应接收回调，可以用于检查响应头、状态码或进行非侵入式的日志记录
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			// 推送开始事件，表示流式响应正式开始，这不是 Anthropic 原始事件，而是项目统一的 AssistantMessageEvent
			stream.push({ type: "start", partial: output });
			// 定义“流式解析期间使用的临时内容块类型”
			// 第一部分：三选一，| 是联合类型，表示一个 Block 首先可能是三种内容之一
			// 其中工具调用的参数在流式过程中不是一次性返回，可能逐段到达，所以需要一个临时的 partialJson 字段来暂存
			// 第二部分：每种内容块都必须有 index，一条 assistant 消息可能同时包含多个块，之后收到增量事件时，可以通过索引找到要更新的内容块
			type Block = (
				| ThinkingContent
				| TextContent
				| (ToolCall & { partialJson: string })
			)
			& { index: number };
			// 在当前流式解析阶段，请把 output.content 看作 Block[]
			// 正式消息内容中没有流式解析需要的 2 个临时字段，但是当前函数在生成过程中会暂时加入这些字段，所以需要更适合内部处理的 Block[] 类型
			// 当做 Block[] 类型后就可以合法访问 2 个临时字段
			const blocks = output.content as Block[];

			for await (const event of iterateAnthropicEvents(response, options?.signal)) {
				// 处理消息开始事件
				if (event.type === "message_start") {
					/* 
					记录：
					- Anthropic 响应 ID；
					- 输入、输出 token；
					- 缓存读取和写入 token；
					- 总 token；
					- 费用
					*/
					output.responseId = event.message.id;
					// Capture initial token usage from message_start event
					// This ensures we have input token counts even if the stream is aborted early
					output.usage.input = event.message.usage.input_tokens || 0;
					output.usage.output = event.message.usage.output_tokens || 0;
					output.usage.cacheRead = event.message.usage.cache_read_input_tokens || 0;
					output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens || 0;
					output.usage.cacheWrite1h = event.message.usage.cache_creation?.ephemeral_1h_input_tokens || 0;
					// Anthropic doesn't provide total_tokens, compute from components
					output.usage.totalTokens =
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					calculateCost(model, output.usage);
				} 
				// 表示一个新内容块开始，创建各种类型的空内容块：文本、思考、工具调用等
				else if (event.type === "content_block_start") {
					if (event.content_block.type === "text") {
						const block: Block = {
							type: "text",
							text: "",
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "thinking") {
						const block: Block = {
							type: "thinking",
							thinking: "",
							thinkingSignature: "",
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "redacted_thinking") {
						// Anthropic 不提供实际推理文本时，项目仍保存一个占位块和签名
						const block: Block = {
							type: "thinking",
							thinking: "[Reasoning redacted]",
							thinkingSignature: event.content_block.data,
							redacted: true,
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "tool_use") {
						const block: Block = {
							type: "toolCall",
							id: event.content_block.id,
							name: isOAuth
								? fromClaudeCodeName(event.content_block.name, context.tools)
								: event.content_block.name,
							arguments: (event.content_block.input as Record<string, any>) ?? {},
							partialJson: "",
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
					}
				} 
				// 这是实际拼接内容的地方
				else if (event.type === "content_block_delta") {
					if (event.delta.type === "text_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "text") {
							block.text += event.delta.text;
							stream.push({
								type: "text_delta",
								contentIndex: index,
								delta: event.delta.text,
								partial: output,
							});
						}
					} else if (event.delta.type === "thinking_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "thinking") {
							block.thinking += event.delta.thinking;
							stream.push({
								type: "thinking_delta",
								contentIndex: index,
								delta: event.delta.thinking,
								partial: output,
							});
						}
					} else if (event.delta.type === "input_json_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "toolCall") {
							block.partialJson += event.delta.partial_json;
							block.arguments = parseStreamingJson(block.partialJson);
							stream.push({
								type: "toolcall_delta",
								contentIndex: index,
								delta: event.delta.partial_json,
								partial: output,
							});
						}
					} else if (event.delta.type === "signature_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "thinking") {
							block.thinkingSignature = block.thinkingSignature || "";
							block.thinkingSignature += event.delta.signature;
						}
					}
				} 
				// 表示某一个内容块已经完成
				else if (event.type === "content_block_stop") {
					const index = blocks.findIndex((b) => b.index === event.index);
					const block = blocks[index];
					if (block) {
						// 删除临时的索引
						delete (block as any).index;
						if (block.type === "text") {
							stream.push({
								type: "text_end",
								contentIndex: index,
								content: block.text,
								partial: output,
							});
						} else if (block.type === "thinking") {
							stream.push({
								type: "thinking_end",
								contentIndex: index,
								content: block.thinking,
								partial: output,
							});
						} else if (block.type === "toolCall") {
							block.arguments = parseStreamingJson(block.partialJson);
							// 删除拼接用的 partialJson
							delete (block as { partialJson?: string }).partialJson;
							stream.push({
								type: "toolcall_end",
								contentIndex: index,
								toolCall: block,
								partial: output,
							});
						}
					}
				} 
				// 这个事件主要更新整条消息的最终状态
				else if (event.type === "message_delta") {
					// 停止原因
					if (event.delta.stop_reason) {
						// 将 Anthropic 的停止原因转换成项目统一类型
						const stopReasonResult = mapStopReason(event.delta.stop_reason, event.delta.stop_details);
						output.stopReason = stopReasonResult.stopReason;
						if (stopReasonResult.errorMessage) {
							output.errorMessage = stopReasonResult.errorMessage;
						}
					}
					// Token 和成本的更新
					if (event.usage.input_tokens != null) {
						output.usage.input = event.usage.input_tokens;
					}
					if (event.usage.output_tokens != null) {
						output.usage.output = event.usage.output_tokens;
					}
					if (event.usage.cache_read_input_tokens != null) {
						output.usage.cacheRead = event.usage.cache_read_input_tokens;
					}
					if (event.usage.cache_creation_input_tokens != null) {
						output.usage.cacheWrite = event.usage.cache_creation_input_tokens;
					}
					/* 
					Anthropic（Claude 模型的 API 提供商）会在 最后一条 message_delta 的 usage 字段中
					通过 output_tokens_details.thinking_tokens 返回“思考令牌”的数量，thinking_tokens
					是 output_tokens（总输出令牌）的一个子集。它单独列出来，是为了让开发者知道“模型花了多少
					算力在内部推理/思考上”，Anthropic 官方的 SDK 版本 0.91.1 在定义 TypeScript 类型时，
					忘记（或还没来得及）在 Usage 接口里加上 thinking_tokens 这个字段。虽然 SDK 的类型定义
					里没有，但我们实际测试过真实的 API 接口，确认接口的返回值里确实有这个字段。所以我们可以放心
					地绕过 TypeScript 的类型检查去读取它。 
					*/
					const thinkingTokens = (event.usage as { output_tokens_details?: { thinking_tokens?: number } })
						.output_tokens_details?.thinking_tokens;
					if (thinkingTokens != null) {
						output.usage.reasoning = thinkingTokens;
					}
					output.usage.totalTokens =
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					calculateCost(model, output.usage);
				}
			}
			// 遍历结束后先检查取消和错误状态
			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error(output.errorMessage || "An unknown error occurred");
			}

			// push(done) 做两件事：
			// - 将 done 事件交给 for await 消费者
			// - 让 stream.result() 得到 output
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as { index?: number }).index;
				// partialJson is only a streaming scratch buffer; never persist it.
				delete (block as { partialJson?: string }).partialJson;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

/**
 * Map ThinkingLevel to Anthropic effort levels for adaptive thinking.
 * Note: effort "max" is only valid on Opus 4.6, while Opus 4.7+ and Fable 5 support "xhigh".
 */
function mapThinkingLevelToEffort(
	model: Model<"anthropic-messages">,
	level: SimpleStreamOptions["reasoning"],
): AnthropicEffort {
	const mapped = level ? model.thinkingLevelMap?.[level] : undefined;
	if (typeof mapped === "string") return mapped as AnthropicEffort;

	switch (level) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		default:
			return "high";
	}
}

export const streamSimple: StreamFunction<"anthropic-messages", SimpleStreamOptions> = (
	model: Model<"anthropic-messages">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	assertRequestAuth(model.provider, options?.apiKey, options?.headers);

	const base = buildBaseOptions(model, context, options, options?.apiKey);
	if (!options?.reasoning) {
		return stream(model, context, { ...base, thinkingEnabled: false } satisfies AnthropicOptions);
	}

	// For models with adaptive thinking: use an effort level.
	// For older models: use budget-based thinking.
	if (model.compat?.forceAdaptiveThinking === true) {
		const effort = mapThinkingLevelToEffort(model, options.reasoning);
		return stream(model, context, {
			...base,
			thinkingEnabled: true,
			effort,
		} satisfies AnthropicOptions);
	}

	// Undefined means the caller did not request an output cap; let the helper use the model cap.
	// Do not coerce to 0 here, or the thinking budget would become the entire max_tokens value.
	const adjusted = adjustMaxTokensForThinking(
		base.maxTokens,
		model.maxTokens,
		options.reasoning,
		options.thinkingBudgets,
	);

	const maxTokens = clampMaxTokensToContext(model, context, adjusted.maxTokens);

	return stream(model, context, {
		...base,
		maxTokens,
		thinkingEnabled: true,
		thinkingBudgetTokens: Math.min(adjusted.thinkingBudget, Math.max(0, maxTokens - 1024)),
	} satisfies AnthropicOptions);
};

function isOAuthToken(apiKey: string): boolean {
	return apiKey.includes("sk-ant-oat");
}

function createClient(
	model: Model<"anthropic-messages">,
	apiKey: string | undefined,
	interleavedThinking: boolean,
	useFineGrainedToolStreamingBeta: boolean,
	optionsHeaders?: ProviderHeaders,
	dynamicHeaders?: Record<string, string>,
	sessionId?: string,
): { client: Anthropic; isOAuthToken: boolean } {
	// Adaptive thinking models have interleaved thinking built in, so skip the beta header.
	const needsInterleavedBeta = interleavedThinking && model.compat?.forceAdaptiveThinking !== true;
	const betaFeatures: string[] = [];
	if (useFineGrainedToolStreamingBeta) {
		betaFeatures.push(FINE_GRAINED_TOOL_STREAMING_BETA);
	}
	if (needsInterleavedBeta) {
		betaFeatures.push(INTERLEAVED_THINKING_BETA);
	}

	// Copilot: Bearer auth, selective betas.
	if (model.provider === "github-copilot") {
		const client = new Anthropic({
			apiKey: null,
			authToken: apiKey ?? null,
			baseURL: model.baseUrl,
			dangerouslyAllowBrowser: true,
			defaultHeaders: mergeHeaders(
				{
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
				},
				model.headers,
				dynamicHeaders,
				optionsHeaders,
			),
		});

		return { client, isOAuthToken: false };
	}

	// OAuth: Bearer auth, Claude Code identity headers
	if (apiKey && isOAuthToken(apiKey)) {
		const client = new Anthropic({
			apiKey: null,
			authToken: apiKey,
			baseURL: model.baseUrl,
			dangerouslyAllowBrowser: true,
			defaultHeaders: mergeHeaders(
				{
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					"anthropic-beta": ["claude-code-20250219", "oauth-2025-04-20", ...betaFeatures].join(","),
					"user-agent": `claude-cli/${claudeCodeVersion}`,
					"x-app": "cli",
				},
				model.headers,
				optionsHeaders,
			),
		});

		return { client, isOAuthToken: true };
	}

	// API key or header-owned auth.
	const sessionAffinityHeaders: ProviderHeaders =
		sessionId && getAnthropicCompat(model).sendSessionAffinityHeaders ? { "x-session-affinity": sessionId } : {};
	const defaultHeaders = mergeHeaders(
		{
			accept: "application/json",
			"anthropic-dangerous-direct-browser-access": "true",
			...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
		},
		sessionAffinityHeaders,
		model.headers,
		optionsHeaders,
	);
	const client = new Anthropic({
		apiKey: apiKey ?? null,
		authToken: null,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		defaultHeaders,
	});

	return { client, isOAuthToken: false };
}

function buildParams(
	model: Model<"anthropic-messages">,
	context: Context,
	isOAuthToken: boolean,
	options?: AnthropicOptions,
): MessageCreateParamsStreaming {
	const { cacheControl } = getCacheControl(model, options?.cacheRetention, options?.env);
	const compat = getAnthropicCompat(model);
	const params: MessageCreateParamsStreaming = {
		model: model.id,
		messages: convertMessages(context.messages, model, isOAuthToken, cacheControl, compat.allowEmptySignature),
		max_tokens: options?.maxTokens ?? model.maxTokens,
		stream: true,
	};

	// For OAuth tokens, we MUST include Claude Code identity
	if (isOAuthToken) {
		params.system = [
			{
				type: "text",
				text: "You are Claude Code, Anthropic's official CLI for Claude.",
				...(cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
		if (context.systemPrompt) {
			params.system.push({
				type: "text",
				text: sanitizeSurrogates(context.systemPrompt),
				...(cacheControl ? { cache_control: cacheControl } : {}),
			});
		}
	} else if (context.systemPrompt) {
		// Add cache control to system prompt for non-OAuth tokens
		params.system = [
			{
				type: "text",
				text: sanitizeSurrogates(context.systemPrompt),
				...(cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
	}

	// Temperature is incompatible with extended thinking and unsupported on Claude Opus 4.7+.
	if (options?.temperature !== undefined && !options?.thinkingEnabled && compat.supportsTemperature) {
		params.temperature = options.temperature;
	}

	if (context.tools && context.tools.length > 0) {
		params.tools = convertTools(
			context.tools,
			isOAuthToken,
			compat.supportsEagerToolInputStreaming,
			compat.supportsCacheControlOnTools ? cacheControl : undefined,
		);
	}

	// Configure thinking mode: adaptive, budget-based, or explicitly disabled.
	if (model.reasoning) {
		if (options?.thinkingEnabled) {
			// Default to "summarized" so Opus 4.7 and Mythos Preview behave like
			// older Claude 4 models (whose API default is also "summarized").
			const display: AnthropicThinkingDisplay = options.thinkingDisplay ?? "summarized";
			if (model.compat?.forceAdaptiveThinking === true) {
				// Adaptive thinking: Claude decides when and how much to think.
				params.thinking = { type: "adaptive", display };
				if (options.effort) {
					// The Anthropic SDK types can lag newly supported effort values such as "xhigh".
					params.output_config =
						options.effort === "xhigh"
							? ({ effort: options.effort } as unknown as NonNullable<
									MessageCreateParamsStreaming["output_config"]
								>)
							: { effort: options.effort };
				}
			} else {
				// Budget-based thinking for older models
				params.thinking = {
					type: "enabled",
					budget_tokens: options.thinkingBudgetTokens || 1024,
					display,
				};
			}
		} else if (options?.thinkingEnabled === false && model.thinkingLevelMap?.off !== null) {
			params.thinking = { type: "disabled" };
		}
	}

	if (options?.metadata) {
		const userId = options.metadata.user_id;
		if (typeof userId === "string") {
			params.metadata = { user_id: userId };
		}
	}

	if (options?.toolChoice) {
		if (typeof options.toolChoice === "string") {
			params.tool_choice = { type: options.toolChoice };
		} else {
			params.tool_choice = options.toolChoice;
		}
	}

	return params;
}

// Normalize tool call IDs to match Anthropic's required pattern and length
function normalizeToolCallId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function convertMessages(
	messages: Message[],
	model: Model<"anthropic-messages">,
	isOAuthToken: boolean,
	cacheControl?: CacheControlEphemeral,
	allowEmptySignature = false,
): MessageParam[] {
	const params: MessageParam[] = [];

	// Transform messages for cross-provider compatibility
	const transformedMessages = transformMessages(messages, model, normalizeToolCallId);

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];

		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				if (msg.content.trim().length > 0) {
					params.push({
						role: "user",
						content: sanitizeSurrogates(msg.content),
					});
				}
			} else {
				const blocks: ContentBlockParam[] = msg.content.map((item) => {
					if (item.type === "text") {
						return {
							type: "text",
							text: sanitizeSurrogates(item.text),
						};
					} else {
						return {
							type: "image",
							source: {
								type: "base64",
								media_type: item.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
								data: item.data,
							},
						};
					}
				});
				const filteredBlocks = blocks.filter((b) => {
					if (b.type === "text") {
						return b.text.trim().length > 0;
					}
					return true;
				});
				if (filteredBlocks.length === 0) continue;
				params.push({
					role: "user",
					content: filteredBlocks,
				});
			}
		} else if (msg.role === "assistant") {
			const blocks: ContentBlockParam[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					if (block.text.trim().length === 0) continue;
					blocks.push({
						type: "text",
						text: sanitizeSurrogates(block.text),
					});
				} else if (block.type === "thinking") {
					// Redacted thinking: pass the opaque payload back as redacted_thinking
					if (block.redacted) {
						blocks.push({
							type: "redacted_thinking",
							data: block.thinkingSignature!,
						});
						continue;
					}
					if (block.thinking.trim().length === 0) continue;
					// If thinking signature is missing/empty (e.g., from aborted stream),
					// convert to plain text for Anthropic. Some compatible providers emit
					// and accept empty signatures, so let marked models preserve the block.
					if (!block.thinkingSignature || block.thinkingSignature.trim().length === 0) {
						blocks.push(
							allowEmptySignature
								? {
										type: "thinking",
										thinking: sanitizeSurrogates(block.thinking),
										signature: "",
									}
								: {
										type: "text",
										text: sanitizeSurrogates(block.thinking),
									},
						);
					} else {
						blocks.push({
							type: "thinking",
							thinking: sanitizeSurrogates(block.thinking),
							signature: block.thinkingSignature,
						});
					}
				} else if (block.type === "toolCall") {
					blocks.push({
						type: "tool_use",
						id: block.id,
						name: isOAuthToken ? toClaudeCodeName(block.name) : block.name,
						input: block.arguments ?? {},
					});
				}
			}
			if (blocks.length === 0) continue;
			params.push({
				role: "assistant",
				content: blocks,
			});
		} else if (msg.role === "toolResult") {
			// Collect all consecutive toolResult messages, needed for z.ai Anthropic endpoint
			const toolResults: ContentBlockParam[] = [];

			// Add the current tool result
			toolResults.push({
				type: "tool_result",
				tool_use_id: msg.toolCallId,
				content: convertContentBlocks(msg.content),
				is_error: msg.isError,
			});

			// Look ahead for consecutive toolResult messages
			let j = i + 1;
			while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
				const nextMsg = transformedMessages[j] as ToolResultMessage; // We know it's a toolResult
				toolResults.push({
					type: "tool_result",
					tool_use_id: nextMsg.toolCallId,
					content: convertContentBlocks(nextMsg.content),
					is_error: nextMsg.isError,
				});
				j++;
			}

			// Skip the messages we've already processed
			i = j - 1;

			// Add a single user message with all tool results
			params.push({
				role: "user",
				content: toolResults,
			});
		}
	}

	// Add cache_control to the last user message to cache conversation history
	if (cacheControl && params.length > 0) {
		const lastMessage = params[params.length - 1];
		if (lastMessage.role === "user") {
			if (Array.isArray(lastMessage.content)) {
				const lastBlock = lastMessage.content[lastMessage.content.length - 1];
				if (
					lastBlock &&
					(lastBlock.type === "text" || lastBlock.type === "image" || lastBlock.type === "tool_result")
				) {
					(lastBlock as any).cache_control = cacheControl;
				}
			} else if (typeof lastMessage.content === "string") {
				lastMessage.content = [
					{
						type: "text",
						text: lastMessage.content,
						cache_control: cacheControl,
					},
				] as any;
			}
		}
	}

	return params;
}

function shouldUseFineGrainedToolStreamingBeta(model: Model<"anthropic-messages">, context: Context): boolean {
	return !!context.tools?.length && !getAnthropicCompat(model).supportsEagerToolInputStreaming;
}

function convertTools(
	tools: Tool[],
	isOAuthToken: boolean,
	supportsEagerToolInputStreaming: boolean,
	cacheControl?: CacheControlEphemeral,
): Anthropic.Messages.Tool[] {
	if (!tools) return [];

	return tools.map((tool, index) => {
		const schema = tool.parameters as { properties?: unknown; required?: string[] };

		return {
			name: isOAuthToken ? toClaudeCodeName(tool.name) : tool.name,
			description: tool.description,
			...(supportsEagerToolInputStreaming ? { eager_input_streaming: true } : {}),
			input_schema: {
				type: "object",
				properties: schema.properties ?? {},
				required: schema.required ?? [],
			},
			...(cacheControl && index === tools.length - 1 ? { cache_control: cacheControl } : {}),
		};
	});
}

function mapStopReason(
	reason: Anthropic.Messages.StopReason | string,
	stopDetails?: RefusalStopDetails | null,
): { stopReason: StopReason; errorMessage?: string } {
	switch (reason) {
		case "end_turn":
			return { stopReason: "stop" };
		case "max_tokens":
			return { stopReason: "length" };
		case "tool_use":
			return { stopReason: "toolUse" };
		case "refusal":
			return {
				stopReason: "error",
				errorMessage: stopDetails?.explanation || `The model refused to complete the request`,
			};
		case "pause_turn": // Stop is good enough -> resubmit
			return { stopReason: "stop" };
		case "stop_sequence":
			return { stopReason: "stop" }; // We don't supply stop sequences, so this should never happen
		case "sensitive": // Content flagged by safety filters (not yet in SDK types)
			return { stopReason: "error" };
		default:
			// Handle unknown stop reasons gracefully (API may add new values)
			throw new Error(`Unhandled stop reason: ${reason}`);
	}
}
