import { lazyStream } from "./api/lazy.ts";
import { defaultProviderAuthContext as defaultAuthContext } from "./auth/context.ts";
import { InMemoryCredentialStore } from "./auth/credential-store.ts";
import { ModelsError, resolveProviderAuth } from "./auth/resolve.ts";
import type { AuthContext, AuthResult, CredentialStore, ProviderAuth } from "./auth/types.ts";
import type {
	Api,
	ApiStreamOptions,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	ModelThinkingLevel,
	ProviderHeaders,
	ProviderStreams,
	SimpleStreamOptions,
	StreamOptions,
	Usage,
} from "./types.ts";

export { type AuthModel, ModelsError, type ModelsErrorCode } from "./auth/resolve.ts";

/* 
Provider 接口定义了一个“模型供应商运行时对象”必须具备哪些能力
可以把 Provider 理解成某个模型平台的 adapter（适配器），例如：
- OpenAI Provider
- Anthropic Provider
- Google Provider
- Amazon Bedrock Provider

它统一负责：
- Provider 的身份信息
- API 地址和请求头
- 身份认证
- 模型列表
- 动态刷新模型
- 调用模型并返回流式响应
这样上层不需要分别了解 OpenAI、Anthropic 等平台的实现差异，只需要操作统一的 Provider 接口。 

TApi 表示这个 Provider 支持哪些 API 协议
例如 OpenAI Provider 可能同时支持:
- "openai-responses"
- "openai-completions"

Anthropic Provider 可能是：
- anthropic-messages

TApi extends Api 表示 TApi 必须属于合法的 Api 类型
在统一的 Models 集合内部，会将不同 Provider 都保存成：Provider<Api>
因为一个集合里可能同时包含多种 API：
- OpenAI Provider
- Anthropic Provider
- Google Provider
具体工厂的直接使用者获得精确类型，而统一集合为了容纳所有 Provider，会使用较宽的公共类型 Api
*/

export interface Provider<TApi extends Api = Api> {
	// readonly 表示创建 Provider 后，不能通过该接口重新赋值
	// id 是程序内部使用的稳定标识
	readonly id: string;
	// name 是用于展示的名称
	readonly name: string;
	// Provider 的默认 API 地址，例如：
	// baseUrl: "https://api.openai.com/v1"
	// ? 表示可选，因为：
	// - 有些 SDK 内置默认地址；
	// - 有些 Provider 动态确定地址；
	// - 有些认证或请求函数自行管理地址。
	// 模型本身也可能有自己的 baseUrl，具体调用层可以按照项目规则决定优先级
	readonly baseUrl?: string;
	// Provider 默认附加的 HTTP 请求头
	// 例如：
	// headers: {
	//   "X-App-Name": "Pi",
	// }
	// 它可能是普通对象，也可能支持动态计算，具体取决于 ProviderHeaders 的定义
	readonly headers?: ProviderHeaders;

	/**
	* 这是 Provider 的认证能力，而且是必需字段。
	* 注释要求每个 Provider 至少支持一种认证语义: apiKey 或 oauth
	* 例如：
	*  - OpenAI       → API Key
	*  - 某些平台     → OAuth
	*  - AWS Bedrock  → AWS Profile / 环境凭证
	*  - Google       → ADC 文件
	*  - 本地模型服务 → 可能不需要真实密钥
	*  即使本地服务不需要 Key，仍然会通过 apiKey 类型的认证接口提供 resolve()，用来报告 Provider 当前是否可用
	*  因此 auth 不只是“返回密码”，也承担了：检查这个 Provider 是否已经正确配置
	 */
	readonly auth: ProviderAuth;

	// 同步返回当前已知的模型列表，readonly Model<TApi>[]表示调用者应该把它看作只读数组，不能随意修改 Provider 内部的模型目录
	// 静态 Provider 在代码中已经拥有模型清单，因此可以立即返回
	// getModels() {
	//   return STATIC_MODELS;
	// }
	// 动态 Provider 需要从远程接口查询模型
	// 注释还规定 getModels() 不应该抛异常。如果实现意外抛错，外层 Models 会将它当作没有模型
	// 这让“读取当前缓存”保持简单可靠
	getModels(): readonly Model<TApi>[];

	// 这是可选方法，只有动态 Provider 才需要实现。
	// 它负责：
	// - 从远程获取模型列表
	// - 更新 Provider 内部保存的模型目录
	// - 完成后不直接返回模型，而是通过 getModels() 读取当前缓存的模型列表
	refreshModels?(): Promise<void>;

	// 这是强类型、API 专用的流式调用方法，T 必须是该厂商 Provider 支持的 API 之一
	stream<T extends TApi>(
		model: Model<T>,
		context: Context,
		// API 专用配置。它会根据具体 API 类型变化
		// 例如不同 API 可能拥有不同的：
		// - reasoning 参数
		// - 缓存参数
		// - Provider 专属请求字段
		// - 兼容性选项
		// 这就是为什么 stream() 需要泛型：模型的 api 类型会决定 options 允许哪些字段
		options?: ApiStreamOptions<T>,
	): AssistantMessageEventStream;

	// 简化版调用接口。与 stream() 的区别主要在配置类型：
	// stream()
	// → ApiStreamOptions<T>
	// → 根据具体 API 提供专用配置
	
	// streamSimple()
	// → SimpleStreamOptions
	// → 使用统一、跨 Provider 的简单配置
	streamSimple(model: Model<TApi>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}

/**
 * Runtime collection of providers plus auth application and stream
 * convenience. Providers own stream behavior; `Models` resolves auth and
 * delegates each request to the provider that owns the model.
 */
export interface Models {
	getProviders(): readonly Provider[];
	getProvider(id: string): Provider | undefined;

	/**
	 * Sync read of last-known models from one provider or all providers.
	 * Best-effort: a provider whose `getModels()` throws yields no models.
	 */
	getModels(provider?: string): readonly Model<Api>[];

	/**
	 * Sync runtime model lookup against last-known lists. Dynamic model lists
	 * are typed as `Model<Api>`; narrow with the `hasApi()` type guard.
	 */
	getModel(provider: string, id: string): Model<Api> | undefined;

	/**
	 * Ask dynamic providers to re-fetch their model lists. With a provider id,
	 * rejects with `ModelsError` ("model_source") on that provider's fetch
	 * failure; without one, refreshes all providers concurrently best-effort.
	 * Static providers (no `refreshModels`) are no-ops.
	 */
	refresh(provider?: string): Promise<void>;

	/**
	 * Resolve request auth for a model. Includes a source label for status UI.
	 * Resolves `undefined` when the provider is unknown or unconfigured.
	 * Rejects with `ModelsError`: code "oauth" when a token refresh fails (the
	 * stored credential is preserved for retry; re-login fixes it), code "auth"
	 * when api-key resolution or the credential store fails. Request paths
	 * surface rejections as stream errors; status/availability UIs catch them
	 * and render "needs re-login" instead of treating them as unconfigured.
	 */
	getAuth(model: Model<Api>): Promise<AuthResult | undefined>;

	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ApiStreamOptions<TApi>,
	): AssistantMessageEventStream;

	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ApiStreamOptions<TApi>,
	): Promise<AssistantMessage>;

	streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
	completeSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage>;
}

export interface MutableModels extends Models {
	/** Upsert/replace by provider.id. Provider ids are unique. */
	setProvider(provider: Provider): void;
	deleteProvider(id: string): void;
	clearProviders(): void;
}

export interface CreateModelsOptions {
	credentials?: CredentialStore;
	authContext?: AuthContext;
}

class ModelsImpl implements MutableModels {
	private providers = new Map<string, Provider>();
	private credentials: CredentialStore;
	private authContext: AuthContext;

	constructor(options?: CreateModelsOptions) {
		this.credentials = options?.credentials ?? new InMemoryCredentialStore();
		this.authContext = options?.authContext ?? defaultAuthContext();
	}

	setProvider(provider: Provider): void {
		this.providers.set(provider.id, provider);
	}

	deleteProvider(id: string): void {
		this.providers.delete(id);
	}

	clearProviders(): void {
		this.providers.clear();
	}

	getProviders(): readonly Provider[] {
		return Array.from(this.providers.values());
	}

	getProvider(id: string): Provider | undefined {
		return this.providers.get(id);
	}

	getModels(provider?: string): readonly Model<Api>[] {
		if (provider !== undefined) {
			const entry = this.providers.get(provider);
			if (!entry) return [];
			try {
				return entry.getModels();
			} catch {
				return [];
			}
		}

		const models: Model<Api>[] = [];
		for (const entry of this.providers.values()) {
			try {
				models.push(...entry.getModels());
			} catch {
				// Best-effort: ill-behaved providers yield no models.
			}
		}
		return models;
	}

	getModel(provider: string, id: string): Model<Api> | undefined {
		return this.getModels(provider).find((model) => model.id === id);
	}

	async refresh(provider?: string): Promise<void> {
		if (provider !== undefined) {
			const entry = this.providers.get(provider);
			if (!entry?.refreshModels) return;
			try {
				await entry.refreshModels();
			} catch (error) {
				if (error instanceof ModelsError) throw error;
				throw new ModelsError("model_source", `Model refresh failed for ${provider}`, { cause: error });
			}
			return;
		}

		// Cannot reject: the async mapper turns even sync throws from ill-behaved
		// providers into rejections, and allSettled captures all of them.
		await Promise.allSettled(Array.from(this.providers.values(), async (entry) => entry.refreshModels?.()));
	}

	async getAuth(model: Model<Api>): Promise<AuthResult | undefined> {
		const provider = this.providers.get(model.provider);
		if (!provider) return undefined;
		return resolveProviderAuth(provider, model, this.credentials, this.authContext);
	}

	private requireProvider(model: Model<Api>): Provider {
		const provider = this.providers.get(model.provider);
		if (!provider) {
			throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
		}
		return provider;
	}

	private async applyAuth<TOptions extends StreamOptions>(
		model: Model<Api>,
		options: TOptions | undefined,
	): Promise<{ requestModel: Model<Api>; requestOptions: TOptions | undefined }> {
		const resolution = await resolveProviderAuth(
			this.requireProvider(model),
			model,
			this.credentials,
			this.authContext,
			{
				apiKey: options?.apiKey,
				env: options?.env,
			},
		);
		const auth = resolution?.auth;
		if (!auth) return { requestModel: model, requestOptions: options };

		const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;

		// Explicit request options win per-field; headers/env merge per key.
		const apiKey = options?.apiKey ?? auth.apiKey;
		const headers = auth.headers || options?.headers ? { ...auth.headers, ...options?.headers } : undefined;
		const env = resolution.env || options?.env ? { ...(resolution.env ?? {}), ...(options?.env ?? {}) } : undefined;
		const requestOptions = { ...options, apiKey, headers, env } as TOptions;

		return { requestModel, requestOptions };
	}

	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ApiStreamOptions<TApi>,
	): AssistantMessageEventStream {
		return lazyStream(model, async () => {
			const provider = this.requireProvider(model);
			const { requestModel, requestOptions } = await this.applyAuth(model, options as StreamOptions | undefined);
			return provider.stream(requestModel as Model<TApi>, context, requestOptions as ApiStreamOptions<TApi>);
		});
	}

	async complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		return this.stream(model, context, options).result();
	}

	streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
		return lazyStream(model, async () => {
			const provider = this.requireProvider(model);
			const { requestModel, requestOptions } = await this.applyAuth(model, options);
			return provider.streamSimple(requestModel, context, requestOptions);
		});
	}

	async completeSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage> {
		return this.streamSimple(model, context, options).result();
	}
}

export function createModels(options?: CreateModelsOptions): MutableModels {
	return new ModelsImpl(options);
}

export interface CreateProviderOptions<TApi extends Api = Api> {
	id: string;
	/** Display name. Default: `id`. */
	name?: string;
	baseUrl?: string;
	headers?: ProviderHeaders;
	/** Required — every provider has auth semantics, even ambient/keyless ones. */
	auth: ProviderAuth;
	/** Initial model list (empty for purely dynamic providers). */
	models: readonly Model<TApi>[];
	/**
	 * Dynamic providers: fetch the current list. Stored on success; concurrent
	 * calls share one in-flight fetch. May reject: the stored list then stays
	 * at its last-known state, the rejection propagates to the caller of
	 * `refreshModels()` (wrapped as ModelsError "model_source" by
	 * `Models.refresh(provider)`), and a later call retries.
	 */
	refreshModels?: () => Promise<readonly Model<TApi>[]>;
	/** Single implementation, or map keyed by `model.api` for mixed-API providers. */
	api: ProviderStreams | Partial<Record<TApi, ProviderStreams>>;
}

/**
 * Builds a provider from parts. Built-in provider factories and models.json
 * custom providers both go through this. A single `api` streams all models;
 * an `api` map dispatches on `model.api`, and a model whose api has no entry
 * produces a stream error.
 */
export function createProvider<TApi extends Api = Api>(input: CreateProviderOptions<TApi>): Provider<TApi> {
	let models = input.models;
	let inflightRefresh: Promise<void> | undefined;
	const refreshModels = input.refreshModels;
	const single =
		typeof (input.api as ProviderStreams).stream === "function" ? (input.api as ProviderStreams) : undefined;
	const byApi = single ? undefined : (input.api as Partial<Record<string, ProviderStreams>>);

	const apiFor = (model: Model<Api>): ProviderStreams | undefined => single ?? byApi?.[model.api];

	const dispatch = (
		model: Model<Api>,
		run: (streams: ProviderStreams) => AssistantMessageEventStream,
	): AssistantMessageEventStream => {
		const streams = apiFor(model);
		if (!streams) {
			return lazyStream(model, async () => {
				throw new ModelsError("stream", `Provider ${input.id} has no API implementation for "${model.api}"`);
			});
		}
		return run(streams);
	};

	return {
		id: input.id,
		name: input.name ?? input.id,
		baseUrl: input.baseUrl,
		headers: input.headers,
		auth: input.auth,
		getModels: () => models,
		refreshModels: refreshModels
			? () => {
					inflightRefresh ??= (async () => {
						try {
							models = await refreshModels();
						} finally {
							inflightRefresh = undefined;
						}
					})();
					return inflightRefresh;
				}
			: undefined,
		stream: (model, context, options) => dispatch(model, (streams) => streams.stream(model, context, options)),
		streamSimple: (model, context, options) =>
			dispatch(model, (streams) => streams.streamSimple(model, context, options)),
	};
}

/**
 * Runtime-checked narrowing for dynamically looked-up models:
 *
 * ```ts
 * const model = models.getModel("anthropic", "claude-opus-4-7");
 * if (model && hasApi(model, "anthropic-messages")) {
 *   // model: Model<"anthropic-messages">, stream options fully typed
 * }
 * ```
 */
export function hasApi<TApi extends Api>(model: Model<Api>, api: TApi): model is Model<TApi> {
	return model.api === api;
}

export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
	// Anthropic charges 2x base input for 1h cache writes.
	const longWrite = usage.cacheWrite1h ?? 0;
	const shortWrite = usage.cacheWrite - longWrite;
	usage.cost.input = (model.cost.input / 1000000) * usage.input;
	usage.cost.output = (model.cost.output / 1000000) * usage.output;
	usage.cost.cacheRead = (model.cost.cacheRead / 1000000) * usage.cacheRead;
	usage.cost.cacheWrite = (model.cost.cacheWrite * shortWrite + model.cost.input * 2 * longWrite) / 1000000;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

const EXTENDED_THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export function getSupportedThinkingLevels<TApi extends Api>(model: Model<TApi>): ModelThinkingLevel[] {
	if (!model.reasoning) return ["off"];

	return EXTENDED_THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh") return mapped !== undefined;
		return true;
	});
}

export function clampThinkingLevel<TApi extends Api>(
	model: Model<TApi>,
	level: ModelThinkingLevel,
): ModelThinkingLevel {
	const availableLevels = getSupportedThinkingLevels(model);
	if (availableLevels.includes(level)) return level;

	const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
	if (requestedIndex === -1) return availableLevels[0] ?? "off";

	for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	for (let i = requestedIndex - 1; i >= 0; i--) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	return availableLevels[0] ?? "off";
}

/**
 * Check if two models are equal by comparing both their id and provider.
 * Returns false if either model is null or undefined.
 */
export function modelsAreEqual<TApi extends Api>(
	a: Model<TApi> | null | undefined,
	b: Model<TApi> | null | undefined,
): boolean {
	if (!a || !b) return false;
	return a.id === b.id && a.provider === b.provider;
}
