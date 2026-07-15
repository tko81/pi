import { IMAGE_MODELS } from "./image-models.generated.ts";
import type { ImagesApi, ImagesModel, KnownImagesProvider } from "./types.ts";

// 自动生成的 IMAGE_MODELS
//           ↓
// 转换成 Map 注册表
//           ↓
// 按 provider/modelId 查询模型

// 建立图片模型注册表
// 外层 Map：provider(openrouter, etc.) → 该 provider 的模型 Map
// 内层 Map：modelId → 模型配置对象
const imageModelRegistry: Map<string, Map<string, ImagesModel<ImagesApi>>> = new Map();

for (const [provider, models] of Object.entries(IMAGE_MODELS)) {
	const providerModels = new Map<string, ImagesModel<ImagesApi>>();
	for (const [id, model] of Object.entries(models)) {
		providerModels.set(id, model as ImagesModel<ImagesApi>);
	}
	imageModelRegistry.set(provider, providerModels);
}

// 根据 Provider 和模型 ID，自动推导该模型使用的 API 类型
// 如果这个模型对象包含 api 字段，就把该字段的类型提取出来，命名为 TApi
// 如果提取出的 API 是合法的 ImagesApi，就返回该类型；否则返回 never
// 推导过程：
// - 找到 IMAGE_MODELS.openrouter
// - 找到 google/gemini-2.5-flash-image
// - 读取它的 api 字段
// - 得到 "openrouter-images"
type ImageModelApi<
	TProvider extends KnownImagesProvider,
	TModelId extends keyof (typeof IMAGE_MODELS)[TProvider],
> = (typeof IMAGE_MODELS)[TProvider][TModelId] extends { api: infer TApi }
	? TApi extends ImagesApi
		? TApi
		: never
	: never;

// 根据 Provider 和模型 ID，获取模型对象
export function getImageModel<
	TProvider extends KnownImagesProvider,
	TModelId extends keyof (typeof IMAGE_MODELS)[TProvider],
>(provider: TProvider, modelId: TModelId): ImagesModel<ImageModelApi<TProvider, TModelId>> {
	const providerModels = imageModelRegistry.get(provider);
	return providerModels?.get(modelId as string) as ImagesModel<ImageModelApi<TProvider, TModelId>>;
}

// 获取所有支持图片输出的 Provider
export function getImageProviders(): KnownImagesProvider[] {
	return Array.from(imageModelRegistry.keys()) as KnownImagesProvider[];
}

// 根据 Provider，获取该 Provider 支持的所有图片模型
export function getImageModels<TProvider extends KnownImagesProvider>(
	provider: TProvider,
): ImagesModel<ImageModelApi<TProvider, keyof (typeof IMAGE_MODELS)[TProvider]>>[] {
	const models = imageModelRegistry.get(provider);
	return models
		? (Array.from(models.values()) as ImagesModel<ImageModelApi<TProvider, keyof (typeof IMAGE_MODELS)[TProvider]>>[])
		: [];
}
