import { join } from "node:path";
import { Agent, type AgentMessage, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, type Message, type Model, streamSimple } from "@earendil-works/pi-ai/compat";
import { getAgentDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import { AgentSession } from "./agent-session.ts";
import { formatNoModelsAvailableMessage } from "./auth-guidance.ts";
import { AuthStorage } from "./auth-storage.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import type { ExtensionRunner, LoadExtensionsResult, SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
import { convertToLlm } from "./messages.ts";
import { ModelRegistry } from "./model-registry.ts";
import { findInitialModel } from "./model-resolver.ts";
import { mergeProviderAttributionHeaders } from "./provider-attribution.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import { DefaultResourceLoader } from "./resource-loader.ts";
import { getDefaultSessionDir, SessionManager } from "./session-manager.ts";
import { SettingsManager } from "./settings-manager.ts";
import { time } from "./timings.ts";
import {
	createBashTool,
	createCodingTools,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadOnlyTools,
	createReadTool,
	createWriteTool,
	type ToolName,
	withFileMutationQueue,
} from "./tools/index.ts";

export interface CreateAgentSessionOptions {
	/** 项目本地资源发现的工作目录。默认：process.cwd() */
	cwd?: string;
	/** 全局配置目录。默认：~/.pi/agent */
	agentDir?: string;

	/** 凭据存储。默认：AuthStorage.create(agentDir/auth.json) */
	authStorage?: AuthStorage;
	/** 模型注册表。默认：ModelRegistry.create(authStorage, agentDir/models.json) */
	modelRegistry?: ModelRegistry;

	/** 使用的模型。默认：从 settings 读取，否则取第一个可用模型 */
	model?: Model<any>;
	/** 思考级别。默认：从 settings 读取，否则为 'medium'（按模型能力截断） */
	thinkingLevel?: ThinkingLevel;
	/** 可循环切换的模型列表（交互模式下 Ctrl+P） */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	/**
	 * 未提供显式工具白名单时的默认工具禁用模式。
	 *
	 * - "all"：启动时不启用任何工具
	 * - "builtin"：禁用默认内置工具（read、bash、edit、write），
	 *   但保留扩展/自定义工具
	 */
	noTools?: "all" | "builtin";
	/**
	 * 可选的工具名称白名单。
	 *
	 * 省略时，pi 启用默认内置工具（read、bash、edit、write），
	 * 并保留扩展/自定义工具，除非 `noTools` 改变了该默认行为。
	 * 提供时，仅启用列出的工具名称。
	 */
	tools?: string[];
	/** 可选的工具名称黑名单。与 `tools` 同时提供时，在白名单之后应用。 */
	excludeTools?: string[];
	/** 要注册的自定义工具（追加到内置工具之外）。 */
	customTools?: ToolDefinition[];

	/** 资源加载器。省略时使用 DefaultResourceLoader。 */
	resourceLoader?: ResourceLoader;

	/** 会话管理器。默认：SessionManager.create(cwd) */
	sessionManager?: SessionManager;

	/** 设置管理器。默认：SettingsManager.create(cwd, agentDir) */
	settingsManager?: SettingsManager;
	/** 扩展runtime启动时用的 session 开始事件元数据。 */
	sessionStartEvent?: SessionStartEvent;
}

/** createAgentSession 的返回结果 */
export interface CreateAgentSessionResult {
	/** 创建的 session */
	session: AgentSession;
	/** 扩展加载结果（交互模式下用于建立 UI 上下文） */
	extensionsResult: LoadExtensionsResult;
	/** session 恢复时使用了与保存时不同的模型时的警告信息 */
	modelFallbackMessage?: string;
}

// 再导出

export * from "./agent-session-runtime.ts";
export type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	SlashCommandInfo,
	SlashCommandSource,
	ToolDefinition,
} from "./extensions/index.ts";
export type { PromptTemplate } from "./prompt-templates.ts";
export type { Skill } from "./skills.ts";
export type { Tool } from "./tools/index.ts";

export {
	withFileMutationQueue,
	// 工具工厂（支持自定义 cwd）
	createCodingTools,
	createReadOnlyTools,
	createReadTool,
	createBashTool,
	createEditTool,
	createWriteTool,
	createGrepTool,
	createFindTool,
	createLsTool,
};

// 辅助函数

function getDefaultAgentDir(): string {
	return getAgentDir();
}

/**
 * 按指定选项创建 AgentSession。
 *
 * 恢复历史 Session
 * → 选择模型
 * → 恢复 thinking level
 * → 创建工具
 * → 构造系统提示词
 * → 创建 Agent
 * → 创建 AgentSession
 */
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const cwd = resolvePath(options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd());
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getDefaultAgentDir();
	let resourceLoader = options.resourceLoader;

	// 使用传入的或新建 AuthStorage 与 ModelRegistry
	const authPath = options.agentDir ? join(agentDir, "auth.json") : undefined;
	const modelsPath = options.agentDir ? join(agentDir, "models.json") : undefined;
	const authStorage = options.authStorage ?? AuthStorage.create(authPath);
	const modelRegistry = options.modelRegistry ?? ModelRegistry.create(authStorage, modelsPath);

	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const sessionManager = options.sessionManager ?? SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir));

	if (!resourceLoader) {
		resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
		time("resourceLoader.reload");
	}

	// 检查 session 是否有可恢复的历史数据
	const existingSession = sessionManager.buildSessionContext();
	const hasExistingSession = existingSession.messages.length > 0;
	const hasThinkingEntry = sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");

	let model = options.model;
	let modelFallbackMessage: string | undefined;

	// session 有历史数据时，尝试从中恢复模型
	if (!model && hasExistingSession && existingSession.model) {
		const restoredModel = modelRegistry.find(existingSession.model.provider, existingSession.model.modelId);
		if (restoredModel && modelRegistry.hasConfiguredAuth(restoredModel)) {
			model = restoredModel;
		}
		if (!model) {
			modelFallbackMessage = `Could not restore model ${existingSession.model.provider}/${existingSession.model.modelId}`;
		}
	}

	// 仍无模型时，用 findInitialModel（先查 settings 默认，再查 provider 默认）
	if (!model) {
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: hasExistingSession,
			defaultProvider: settingsManager.getDefaultProvider(),
			defaultModelId: settingsManager.getDefaultModel(),
			defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
			modelRegistry,
		});
		model = result.model;
		if (!model) {
			modelFallbackMessage = formatNoModelsAvailableMessage();
		} else if (modelFallbackMessage) {
			modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
		}
	}

	let thinkingLevel = options.thinkingLevel;

	// session 有历史数据时，从中恢复思考级别
	if (thinkingLevel === undefined && hasExistingSession) {
		thinkingLevel = hasThinkingEntry
			? (existingSession.thinkingLevel as ThinkingLevel)
			: (settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
	}

	// 回退到 settings 默认值
	if (thinkingLevel === undefined) {
		thinkingLevel = settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
	}

	// 按模型能力截断
	if (!model) {
		thinkingLevel = "off";
	} else {
		thinkingLevel = clampThinkingLevel(model, thinkingLevel) as ThinkingLevel;
	}

	const defaultActiveToolNames: ToolName[] = ["read", "bash", "edit", "write"];
	const allowedToolNames = options.tools ?? (options.noTools === "all" ? [] : undefined);
	const excludedToolNames = options.excludeTools;
	const excludedToolNameSet = excludedToolNames ? new Set(excludedToolNames) : undefined;
	const initialActiveToolNames: string[] = (
		options.tools ? [...options.tools] : options.noTools ? [] : defaultActiveToolNames
	).filter((name) => !excludedToolNameSet?.has(name));

	let agent: Agent;

	// 创建 convertToLlm 包装器：启用 blockImages 时过滤图片（纵深防御）
	const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
		// LLM 只接受 user / assistant / toolResult 三种角色
		// 其他 msg 需要转换为 user 角色的身份发送，所以 agent 的 msg 要转换
		const converted = convertToLlm(messages);

		// 判断是否禁用图片
		if (!settingsManager.getBlockImages()) {
			return converted;
		}

		// 从所有消息中过滤 ImageContent，替换为文本占位符
		return converted.map((msg) => {
			if (msg.role === "user" || msg.role === "toolResult") {
				const content = msg.content;
				if (Array.isArray(content)) {
					const hasImages = content.some((c) => c.type === "image");
					if (hasImages) {
						const filteredContent = content
							.map((c) =>
								c.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : c,
							)
							.filter(
								(c, i, arr) =>
									// 去重连续的 "Image reading is disabled." 文本
									!(
										c.type === "text" &&
										c.text === "Image reading is disabled." &&
										i > 0 &&
										arr[i - 1].type === "text" &&
										(arr[i - 1] as { type: "text"; text: string }).text === "Image reading is disabled."
									),
							);
						return { ...msg, content: filteredContent };
					}
				}
			}
			return msg;
		});
	};

	const extensionRunnerRef: { current?: ExtensionRunner } = {};

	agent = new Agent({
		initialState: {
			systemPrompt: "",
			model,
			thinkingLevel,
			tools: [],
		},
		convertToLlm: convertToLlmWithBlockImages,
		streamFn: async (model, context, options) => {
			const auth = await modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) {
				throw new Error(auth.error);
			}
			const env = auth.env || options?.env ? { ...(auth.env ?? {}), ...(options?.env ?? {}) } : undefined;
			const providerRetrySettings = settingsManager.getProviderRetrySettings();
			const httpIdleTimeoutMs = settingsManager.getHttpIdleTimeoutMs();
			// SDK 将 timeout=0 视为 0ms（立即超时），而非「无超时」。
			// 使用 int32 最大值以有效禁用超时。
			const effectiveTimeoutMs = httpIdleTimeoutMs === 0 ? 2147483647 : httpIdleTimeoutMs;
			const timeoutMs = options?.timeoutMs ?? providerRetrySettings.timeoutMs ?? effectiveTimeoutMs;
			const websocketConnectTimeoutMs =
				options?.websocketConnectTimeoutMs ?? settingsManager.getWebSocketConnectTimeoutMs();
			return streamSimple(model, context, {
				...options,
				apiKey: auth.apiKey,
				env,
				timeoutMs,
				websocketConnectTimeoutMs,
				maxRetries: options?.maxRetries ?? providerRetrySettings.maxRetries,
				maxRetryDelayMs: options?.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
				headers: mergeProviderAttributionHeaders(
					model,
					settingsManager,
					options?.sessionId,
					auth.headers,
					options?.headers,
				),
			});
		},
		onPayload: async (payload, _model) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("before_provider_request")) {
				return payload;
			}
			return runner.emitBeforeProviderRequest(payload);
		},
		onResponse: async (response, _model) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("after_provider_response")) {
				return;
			}
			await runner.emit({
				type: "after_provider_response",
				status: response.status,
				headers: response.headers,
			});
		},
		sessionId: sessionManager.getSessionId(),
		transformContext: async (messages) => {
			const runner = extensionRunnerRef.current;
			if (!runner) return messages;
			return runner.emitContext(messages);
		},
		steeringMode: settingsManager.getSteeringMode(),
		followUpMode: settingsManager.getFollowUpMode(),
		transport: settingsManager.getTransport(),
		thinkingBudgets: settingsManager.getThinkingBudgets(),
		maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
	});

	// session 有历史数据时恢复消息
	if (hasExistingSession) {
		agent.state.messages = existingSession.messages;
		if (!hasThinkingEntry) {
			sessionManager.appendThinkingLevelChange(thinkingLevel);
		}
	} else {
		// 新 session 保存初始模型与思考级别，便于 resume 时恢复
		if (model) {
			sessionManager.appendModelChange(model.provider, model.id);
		}
		sessionManager.appendThinkingLevelChange(thinkingLevel);
	}

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd,
		scopedModels: options.scopedModels,
		resourceLoader,
		customTools: options.customTools,
		modelRegistry,
		initialActiveToolNames,
		allowedToolNames,
		excludedToolNames,
		extensionRunnerRef,
		sessionStartEvent: options.sessionStartEvent,
	});
	const extensionsResult = resourceLoader.getExtensions();

	return {
		session,
		extensionsResult,
		modelFallbackMessage,
	};
}
