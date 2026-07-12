import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { loadAnthropicOAuth } from "../utils/oauth/load.ts";
import { ANTHROPIC_MODELS } from "./anthropic.models.ts";

export function anthropicProvider(): Provider<"anthropic-messages"> {
	return createProvider({
		id: "anthropic",
		name: "Anthropic",
		baseUrl: "https://api.anthropic.com",
		auth: {
			// ANTHROPIC_OAUTH_TOKEN takes precedence over ANTHROPIC_API_KEY
			apiKey: envApiKeyAuth("Anthropic API key", ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]),
			oauth: lazyOAuth({ name: "Anthropic (Claude Pro/Max)", load: loadAnthropicOAuth }),
		},
		models: Object.values(ANTHROPIC_MODELS),
		// anthropicMessagesApi() 是懒加载包装器，它会在第一次被调用时动态加载 anthropic-messages.ts 模块
		// lazyApi() 返回 stream() 和 streamSimple() 两个方法
		api: anthropicMessagesApi(),
	});
}
