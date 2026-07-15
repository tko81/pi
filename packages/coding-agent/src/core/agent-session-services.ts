import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { getAgentDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import { AuthStorage } from "./auth-storage.ts";
import type { SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
import { ModelRegistry } from "./model-registry.ts";
import {
	DefaultResourceLoader,
	type DefaultResourceLoaderOptions,
	type ResourceLoader,
	type ResourceLoaderReloadOptions,
} from "./resource-loader.ts";
import { type CreateAgentSessionOptions, type CreateAgentSessionResult, createAgentSession } from "./sdk.ts";
import type { SessionManager } from "./session-manager.ts";
import { SettingsManager } from "./settings-manager.ts";

/**
 * 在创建 services or sessions 期间收集的非致命问题
 * runtime 创建过程中将诊断信息返回给调用方，而不是直接打印或退出。
 * 应用层决定是否应显示警告，以及错误是否应中止启动过程。
 */
export interface AgentSessionRuntimeDiagnostic {
	type: "info" | "warning" | "error";
	message: string;
}

/**
 * Inputs for creating cwd-bound runtime services.
 *
 * These services are recreated whenever the effective session cwd changes.
 * CLI-provided resource paths should be resolved to absolute paths before they
 * reach this function, so later cwd switches do not reinterpret them.
 */
export interface CreateAgentSessionServicesOptions {
	/** 当前工作目录。必填 */
	cwd: string;
	/** 全局配置目录。默认：~/.pi/agent */
	agentDir?: string;
	/** 凭据存储。默认：AuthStorage.create(agentDir/auth.json) */
	authStorage?: AuthStorage;
	/** 设置管理器。默认：SettingsManager.create(cwd, agentDir) */
	settingsManager?: SettingsManager;
	/** 模型注册表。默认：ModelRegistry.create(authStorage, agentDir/models.json) */
	modelRegistry?: ModelRegistry;
	/** 扩展标志值。默认：undefined */
	extensionFlagValues?: Map<string, boolean | string>;
	/** 资源加载器选项。默认：{ cwd, agentDir, settingsManager } */
	resourceLoaderOptions?: Omit<DefaultResourceLoaderOptions, "cwd" | "agentDir" | "settingsManager">;
	/** 资源加载器重新加载选项。默认：{} */
	resourceLoaderReloadOptions?: ResourceLoaderReloadOptions;
}

/**
 * 入参类型：用已经建好的 AgentSessionServices 来创建 AgentSession。
 * 不是从零开始，services 必须先存在。
 *
 * 调用时机：createAgentSessionServices() 跑完之后再用，不能跳过 services 直接调这个。
 * 传进来之前，所有绑 cwd 的选项要对着 services 算好：模型、工具、thinking 等。
 * 这些在 CLI 里就是 buildSessionOptions() 干的事。
 *
 * 厨房（services）装好了、菜也点好了（model/tools 定下来了）
 * 这个类型就是「下单开火」的传参——把厨房 + 菜单交给 createAgentSession() 真正做出 AgentSession。
 */
export interface CreateAgentSessionFromServicesOptions {
	services: AgentSessionServices;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	tools?: string[];
	excludeTools?: CreateAgentSessionOptions["excludeTools"];
	noTools?: CreateAgentSessionOptions["noTools"];
	customTools?: ToolDefinition[];
}

/**
 * AgentSessionServices 是一套完整、绑在某个 cwd 上的 runtime service。
 * cwd 定了，里面的 settings、扩展、模型注册表、资源加载器都按这个项目目录配好，彼此一致。
 * 它只是基础设施，不是能对话的 session。没有 prompt()，不管消息流，只管环境备好，AgentSession 另一步再建。
 * 原因：选 model、tools、thinking 时要先查 modelRegistry、settingsManager——这些都在 services 里。
 * 顺序必须是：先 services → 对着 services 解析选项 → 再 createAgentSession。
 * 这是「厨房设备清单」，不是「正在做的菜」。先装好厨房，再决定做什么菜、用什么锅（model/tools），最后才开火（AgentSession）。
 */
export interface AgentSessionServices {
	cwd: string;
	agentDir: string;
	authStorage: AuthStorage;
	settingsManager: SettingsManager;
	modelRegistry: ModelRegistry;
	resourceLoader: ResourceLoader;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

function applyExtensionFlagValues(
	resourceLoader: ResourceLoader,
	extensionFlagValues: Map<string, boolean | string> | undefined,
): AgentSessionRuntimeDiagnostic[] {
	if (!extensionFlagValues) {
		return [];
	}

	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	const extensionsResult = resourceLoader.getExtensions();
	const registeredFlags = new Map<string, { type: "boolean" | "string" }>();
	for (const extension of extensionsResult.extensions) {
		for (const [name, flag] of extension.flags) {
			registeredFlags.set(name, { type: flag.type });
		}
	}

	const unknownFlags: string[] = [];
	for (const [name, value] of extensionFlagValues) {
		const flag = registeredFlags.get(name);
		if (!flag) {
			unknownFlags.push(name);
			continue;
		}
		if (flag.type === "boolean") {
			extensionsResult.runtime.flagValues.set(name, true);
			continue;
		}
		if (typeof value === "string") {
			extensionsResult.runtime.flagValues.set(name, value);
			continue;
		}
		diagnostics.push({
			type: "error",
			message: `Extension flag "--${name}" requires a value`,
		});
	}

	if (unknownFlags.length > 0) {
		diagnostics.push({
			type: "error",
			message: `Unknown option${unknownFlags.length === 1 ? "" : "s"}: ${unknownFlags.map((name) => `--${name}`).join(", ")}`,
		});
	}

	return diagnostics;
}

/**
 * 装「厨房」：绑在某个 cwd 上的基础设施包，不创建 AgentSession，不能 prompt()
 *
 * 做的事：
 * 建 AuthStorage（auth.json）
 * 建 SettingsManager（读全局 + 项目 settings.json）
 * 建 ModelRegistry（models.json + 扩展注册的 provider）
 * 建 DefaultResourceLoader 并 reload()（按 settings 发现 extensions/skills/prompts/themes）
 * 注册扩展里的自定义 provider、处理 --extension-flag
 * 返回 AgentSessionServices + diagnostics
 *
 * 何时重建： cwd 变了（/new、换项目）→ services 整套重做，保证扩展/设置/模型注册表和当前目录一致。
 */
export async function createAgentSessionServices(
	options: CreateAgentSessionServicesOptions,
): Promise<AgentSessionServices> {
	const cwd = resolvePath(options.cwd);
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getAgentDir();
	const authStorage = options.authStorage ?? AuthStorage.create(join(agentDir, "auth.json"));
	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const modelRegistry = options.modelRegistry ?? ModelRegistry.create(authStorage, join(agentDir, "models.json"));
	const resourceLoader = new DefaultResourceLoader({
		...(options.resourceLoaderOptions ?? {}),
		cwd,
		agentDir,
		settingsManager,
	});
	await resourceLoader.reload(options.resourceLoaderReloadOptions);

	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	const extensionsResult = resourceLoader.getExtensions();
	for (const { name, config, extensionPath } of extensionsResult.runtime.pendingProviderRegistrations) {
		try {
			modelRegistry.registerProvider(name, config);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			diagnostics.push({
				type: "error",
				message: `Extension "${extensionPath}" error: ${message}`,
			});
		}
	}
	extensionsResult.runtime.pendingProviderRegistrations = [];
	diagnostics.push(...applyExtensionFlagValues(resourceLoader, options.extensionFlagValues));

	return {
		cwd,
		agentDir,
		authStorage,
		settingsManager,
		modelRegistry,
		resourceLoader,
		diagnostics,
	};
}

/**
 * 开火做菜：已有 services 的前提下，加上本次会话选项，调底层 SDK 建 session。
 * 建 session 之前，调用方得先对着目标 cwd 把 model、thinking、tools 等算清楚；
 * 算这些要依赖 services 里已有的东西（modelRegistry、settingsManager、resourceLoader）
 * 所以拆三步：
 * ① createAgentSessionServices(cwd)   → 备好环境
 * ② 对着 services 解析 model/tools   → buildSessionOptions 等
 * ③ createAgentSessionFromServices()    → 再建 AgentSession
 *
 * services 绑 cwd。换项目目录 → settings、扩展、skills 路径都变。必须先按这个 cwd 建好 services，再在里面查：
 * settingsManager.getDefaultModel()
 * modelRegistry.find(...)
 * settingsManager.getEnabledModels() → 解析 --models
 * 不能 cwd 还没定、registry 还没加载就建 session。
 */
export async function createAgentSessionFromServices(
	options: CreateAgentSessionFromServicesOptions,
): Promise<CreateAgentSessionResult> {
	return createAgentSession({
		// 传入 AgentSessionServices 中的 cwd、agentDir、authStorage、settingsManager、modelRegistry、resourceLoader
		cwd: options.services.cwd,
		agentDir: options.services.agentDir,
		authStorage: options.services.authStorage,
		settingsManager: options.services.settingsManager,
		modelRegistry: options.services.modelRegistry,
		resourceLoader: options.services.resourceLoader,

		sessionManager: options.sessionManager,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		scopedModels: options.scopedModels,
		tools: options.tools,
		excludeTools: options.excludeTools,
		noTools: options.noTools,
		customTools: options.customTools,
		sessionStartEvent: options.sessionStartEvent,
	});
}
