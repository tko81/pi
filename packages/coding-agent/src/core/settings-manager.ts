import type { Transport } from "@earendil-works/pi-ai";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import { DEFAULT_HTTP_IDLE_TIMEOUT_MS, parseHttpIdleTimeoutMs } from "./http-dispatcher.ts";

/**
 * 两层配置：~/.pi/agent/settings.json（全局）+ <cwd>/.pi/settings.json（项目）
 * 信任控制：projectTrusted 决定是否加载/写项目设置
 * 合并策略：项目覆盖全局；嵌套对象递归 merge
 * 安全写盘：文件锁 + 写队列；只 persist 改过的字段（modifiedFields / modifiedNestedFields）
 * 版本迁移：migrateSettings 把旧字段名（如 queueMode）转成新格式
 * 错误收集：解析失败记入 errors，drainErrors() 给上层报 diagnostic
 */

/**
 * 会话压缩配置：对话太长、快顶满模型上下文时，pi 会把旧消息摘要成一段 summary，腾出 token
 */
export interface CompactionSettings {
	// 是否开启自动压缩，默认为 true，false 则不会自动做（仍可手动 /compact）
	enabled?: boolean;

	// 预留给本轮对话的 token 空间（用户输入 + 模型回复）
	// 触发条件：当前上下文 token 数 > contextWindow - reserveTokens
	// 默认留 16384，避免把上下文塞满导致模型没地方输出
	reserveTokens?: number; 

	// 压缩时保留多少最近消息的 token 不被压缩，默认 20000，既控总长，又保证近期对话细节还在
	keepRecentTokens?: number;
}

/**
 * 用 /tree 从当前分支跳到另一条线时，刚离开的那条分支可以先摘要再切，避免丢掉重要上下文
 * 树怎么工作
 * 
 * ├─ user: "重构 auth"
 * │  └─ assistant: "方案 A..."
 * │     ├─ user: "试 A"          ← 分支 1（你刚离开）
 * │     │  └─ assistant: "..."
 * │     └─ user: "改试 B"        ← 分支 2（当前 active）
 * │        └─ assistant: "..."
 * 
 * 整棵树都在一个 .jsonl 里（所有分支都存着）
 * 活跃上下文 = 从 root 沿 parentId 走到当前 leaf 的消息链
 * 模型只看这条链，别的分支消息不进 prompt
 * 
 * /tree 切分支 = 把 leaf 挪到树上另一个点，活跃路径换掉，之前那条线的原文不再发给模型。
 * 
 * 为什么要摘要
 * 切走时，刚离开的分支可能很长（多轮 tool call、关键结论）。
 * leaf 一挪，那些消息还在文件里，但不再出现在上下文里——模型等于「忘了」你刚在那条线里干了什么。
 * 分支摘要的作用：把即将离开的那条分支压成一段 summary，挂到新位置。
 * 新路径上模型仍能看到「之前另一条线大概做了什么」，又不用把整段历史塞回 context。
 * 文档原话：preserve context from the path you left without replaying the whole branch。
 * 
 * 弹窗问「Summarize branch?」可以选不摘要——接受切换后丢失那条线的细节。branchSummary.skipPrompt: true 则默认不摘要、直接切。
 * 
 * 一句话：分支共用一个 session 文件，但不同时进模型上下文；切分支会换掉活跃路径，摘要用来把旧路径的精华带到新路径上。
 */
export interface BranchSummarySettings {
	// 预留给分支摘要的 token 空间（用户输入 + 模型回复）,与上面类似，默认 16384
	reserveTokens?: number; 

	// 切分支时，弹窗是否跳过 "Summarize branch?" 提示，默认 false，true 则不提示，直接摘要
	skipPrompt?: boolean; 
}

/**
 * 提供者重试设置
 * 调模型 API 时 SDK 层：
 * timeoutMs: 单次 HTTP 请求超时（毫秒）
 * maxRetries: provider SDK 自动重试次数
 * maxRetryDelayMs: 服务端要求等待的上限，默认 60000ms，超了失败
 */
export interface ProviderRetrySettings {
	timeoutMs?: number;
	maxRetries?: number;
	maxRetryDelayMs?: number;
}

/**
 * agent 层，整轮对话失败后自动重跑：
 * enabled: 是否开启，默认 true
 * maxRetries: 最多重试几轮，默认 3
 * baseDelayMs: 指数退避基数，默认 2000ms（2s、4s、8s…）
 * provider: 嵌套上面的 provider 重试配置
 */
export interface RetrySettings {
	enabled?: boolean;
	maxRetries?: number;
	baseDelayMs?: number;
	provider?: ProviderRetrySettings;
}

/**
 * howImages
 * showImages: 终端里是否显示图片，默认 true（终端得支持）
 * imageWidthCells: 内联图宽度（字符格），默认 60
 * clearOnShrink: 内容变短时是否清掉空行，默认 false
 * showTerminalProgress: 是否发 OSC 9;4 进度条给终端，默认 false
 */
export interface TerminalSettings {
	showImages?: boolean;
	imageWidthCells?: number;
	clearOnShrink?: boolean;
	showTerminalProgress?: boolean;
}

/**
 * 发给模型的图片
 * autoResize: 发给模型前是否缩到最大 2000×2000，默认 true
 * blockImages: 为 true 时所有图片都不发给 LLM，换成占位文本，默认 false
 */
export interface ImageSettings {
	autoResize?: boolean;
	blockImages?: boolean;
}

/**
 * 思考 token 预算
 * 给支持 thinking 的模型，按级别设自定义 token 上限：
 * minimal / low / medium / high — 对应各 thinking level 的预算。不设则用模型/provider 默认。
 */
export interface ThinkingBudgetsSettings {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

/**
 * Markdown 渲染设置
 * 代码块缩进，默认两个空格 " "
 */
export interface MarkdownSettings {
	codeBlockIndent?: string;
}

/**
 * 警告设置
 */
export interface WarningSettings {
	anthropicExtraUsage?: boolean; // 是否显示 Anthropic 额外用量相关警告，默认 true

}

/**
 * 默认项目信任设置
 * 全局-only，未单独存过信任决定时用：
 * ask: 默认，非交互模式不加载项目扩展等，交互会问
 * always: 默认信任项目资源
 * never: 默认不信任
 * 也可用 CLI --approve / --no-approve 单次覆盖。
 */
export type DefaultProjectTrust = "ask" | "always" | "never";

/**
 * 传输设置
 * 来自 pi-ai："sse" | "websocket" | "websocket-cached" | "auto"。
 * 控制和部分 provider 通信用 SSE 还是 WebSocket；auto 自动选。
 */
export type TransportSetting = Transport;

/**
 * 扩展包来源
 * 从 npm/git 装 pi 资源包时的格式：
 * 字符串："@scope/pkg" — 加载包内全部资源
 * 对象：指定 source，并可只加载部分：
 * extensions / skills / prompts / themes — 白名单路径
 * 配合 settings.packages 数组，由 pi 包管理 / ResourceLoader 发现扩展、skills 等。
 */
export type PackageSource =
	| string
	| {
			source: string;
			extensions?: string[];
			skills?: string[];
			prompts?: string[];
			themes?: string[];
	  };

export interface Settings {
	lastChangelogVersion?: string;
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	// 参考 代码分析/transport分析.MD
	transport?: TransportSetting;

	// agent 还在跑时，你可以先打字排队，两条队列、两种快捷键：
	// steering Enter触发 当前 assistant 回合结束（tool call 跑完）后，立刻插入
	// follow-up Alt+Enter触发 agent 全部干完（不再 streaming）后再插入

	// steeringMode / followUpMode 控制：到 drain 点时，一次注入几条排队消息
	// "one-at-a-time" 每次只注入最早 1 条，剩下的下次 drain 再发
	// "all" 一次把队列里全部消息注入
	steeringMode?: "all" | "one-at-a-time";
	followUpMode?: "all" | "one-at-a-time";

	theme?: string;
	compaction?: CompactionSettings;
	branchSummary?: BranchSummarySettings;
	retry?: RetrySettings;
	hideThinkingBlock?: boolean;
	// Ctrl+G 外部编辑器 = 在 Pi 终端输入框里按 Ctrl+G，把当前正在写的消息丢给你熟悉的桌面编辑器（VS Code、vim、nano 等）去改，改完回到 Pi 继续发。
	// Pi 自带终端内联编辑器，写短句够用；写长 prompt、多行说明、贴大段文字时别扭。Ctrl+G → 临时文件 → 启动外部编辑器 → 保存退出 → 内容回到 Pi 输入框。
	externalEditor?: string; 
	// 自定义 shell = 手动指定 Pi 跑 bash 工具时用哪个 shell 可执行文件（zsh/bash...）
	// Pi agent 会替模型执行 shell 命令，不是直接用你当前终端那个 shell，而是 Pi 自己 spawn 一个子进程来跑
	shellPath?: string;
	// 启动时少打日志
	quietStartup?: boolean;
	// 新项目默认信不信任
	defaultProjectTrust?: DefaultProjectTrust;
	// shellCommandPrefix = 每条 bash 命令执行前，自动拼在前面的一段 shell 脚本
	// 实现：resolvedCommand = commandPrefix + "\n" + command
	// 每条 bash 前加前缀（如开 alias）
	shellCommandPrefix?: string;
	// 查/装 npm 包用的命令（如 ["mise","exec","node@20","--","npm"]）
	npmCommand?: string[];
	// Pi 发现你版本升了（lastChangelogVersion < 当前版本）→ 新 session 启动 → 弹更新说明
	// 已有消息的 resumed session、全新安装 → 都不走这套。
	// false（默认）完整 What's New：Markdown 渲染本次升级全部 changelog
	// true 一行：升级至 vX.Y.Z. 使用 /changelog 命令展示全部 changelog.
	collapseChangelog?: boolean;
	// 1. 官方的安装/更新统计后门：首次安装，或 changelog 发现你刚升到新版本时，客户端 → 服务器：「我装/升到这个版本了」，匿名统计安装量、升级量
	// 2. 为 OpenRouter / NVIDIA NIM / Cloudflare 等请求加来源 attribution headers（标明请求来自 Pi）
	// 意思：Pi 调某些第三方模型 API 时，在 HTTP 请求里多塞几个 header，告诉对方「这请求是 Pi 这个 CLI 发的」，不是随便哪个网页/脚本
	enableInstallTelemetry?: boolean;
	// 可选 analytics 数据共享开关，默认关。属于预留/实验中的 opt-in 开关
	// 目前主要在实验性首次设置（PI_EXPERIMENTAL=1）里问用户要不要开；用户选「分享 analytics」→ setEnableAnalytics(true) 写入全局 settings.json
	enableAnalytics?: boolean;
	// analytics 用的匿名设备 ID
	// 只有 setEnableAnalytics(true) 且还没有 id 时，才 randomUUID() 生成并持久化
	// 关 analytics 不会删 id；再开 analytics 会复用同一个 id（测试里验证了）
	trackingId?: string;
	// packages → 远程/可安装包，pi 会 npm install 或 git clone 到 ~/.pi/agent/npm|git/ 或 .pi/npm|git/
	// packages 不替代 下面四个字段，而是另一种来源
	packages?: PackageSource[]; // Array of npm/git package sources (string or object with filtering)
	// 挂生命周期事件、注册 LLM 工具、/command、改 UI、拦截 tool call 等，会执行代码
	extensions?: string[];
	// 给模型看的专项工作流/说明/脚本指引。符合 Agent Skills 标准。可注册成 /skill:name
	skills?: string[];
	// 编辑器里打 /模板名 展开成完整 prompt，支持 $1、$@ 等占位符
	prompts?: string[];
	// 定义 TUI 颜色 token（dark/light 之外自定义主题）
	themes?: string[];

	// 是否把已加载的 skill 注册成 /skill:name 斜杠命令
	// true（默认） → 自动补全里出现 /skill:pdf-tools 等；输入后展开成完整 skill 内容发给模型
	// false → 没有这些命令，skill 仍可通过 system prompt 里的描述让模型按需 read SKILL.md

	// 和自动加载的区别：
	// system prompt 只放 skill 名称+描述（渐进披露）
	// /skill:name 是你主动触发，直接把 SKILL.md 全文塞进输入
	// 设 disable-model-invocation: true 的 skill 不进 system prompt，只能靠 /skill:name 调用 → 此时必须 enableSkillCommands: true。
	enableSkillCommands?: boolean;
	terminal?: TerminalSettings;
	images?: ImageSettings;

	// 限制 模型轮换 的候选列表，格式同 CLI --models（默认不设 = 全部模型）
	// 未设 → 所有已配置 auth 的模型都可轮换
	// 设了 → Ctrl+P / 模型轮换，只在这批模型里切
	// 注意： 这是轮换范围，不是「禁止用别的模型」——你仍可在 /model 里手动选列表外的模型
	enabledModels?: string[];
	
	// 输入框为空时，500ms 内连按两次 Esc 触发的动作（默认 "tree"）
	// "tree" 打开 /tree 会话树选择器（同一会话内切分支）
	// "fork" 打开 fork 选择器（从历史 user 消息 fork 到新会话文件）
	// "none" 不做事
	doubleEscapeAction?: "fork" | "tree" | "none";

	// 打开 /tree 时默认显示哪些节点。树内仍可用 Ctrl+O 临时切换过滤
	// default 常规视图；隐藏 label/custom/model_change 等 bookkeeping；隐藏「只有 tool call、无文字」的 assistant 消息
	// no-tools default 基础上再隐藏 tool result
	// user-only 只看 user 消息
	// labeled-only 只看打了 label 的节点（Shift+L 标记）
	// all 全部条目，含设置变更、tool result 等
	// 注意：长会话树很乱时，设 user-only 或 no-tools 能更快定位分支点。
	treeFilterMode?: "default" | "no-tools" | "user-only" | "labeled-only" | "all"; // Default filter when opening /tree
	thinkingBudgets?: ThinkingBudgetsSettings; // Custom token budgets for thinking levels
	// 输入框左右留白（默认 0，范围 0–3） 终端窄或想输入区和聊天区对齐时可调 /settings 可改，立即生效
	editorPaddingX?: number;
	// 聊天输出左右留白——user 消息、assistant 回复、thinking 块、错误文本。
	// 1 → 内容离左边缘空 1 格（默认，更易读）
	// 0 → 贴边，多挤一点横向空间
	// 传给 UserMessage / AssistantMessage 等 TUI 组件的 padding 参数，纯视觉，不影响逻辑
	outputPad?: 0 | 1;
	// 输入框自动补全下拉框最多显示几条
	// 默认 5，范围 3–20
	// 输入 /、路径、@ 等触发补全时生效
	// 在 Editor 里传给 SelectList 控制高度；项多时可滚动，只是可见行数变
	autocompleteMaxVisible?: number;
	// 终端实体光标是否显示
	// Pi TUI 自己画输入区，默认隐藏硬件光标（界面更干净），但仍用 ANSI 把光标挪到正确位置——给 IME 输入法（中文等）定位候选框用。
	// 默认 false（隐藏）
	// true → 定位后调用 showCursor()，你能看到闪烁光标
	// 环境变量 PI_HARDWARE_CURSOR=1 等效
	// 典型场景： WSL + WezTerm 打中文，候选框跟不准输入位置 → 开这个。
	// 候选框 = 输入法打中文/日文时，光标附近弹出的选字/选词小窗口。
	// 例：拼音打 nihao → 候选框显示 你好 你好 泥好… 你选一条上屏。
	showHardwareCursor?: boolean; // Show terminal cursor while still positioning it for IME
	markdown?: MarkdownSettings;
	warnings?: WarningSettings;
	sessionDir?: string; // Custom session storage directory (same format as --session-dir CLI flag)
	// Pi 出站 HTTP/HTTPS 走代理用的
	// 典型用途：
	// 调 OpenAI、Anthropic 等模型 API
	// 版本检查、包更新检查
	// 其他 Pi 发起的网络请求
	httpProxy?: string;
	// HTTP 请求空闲超时（毫秒）——等响应头/响应体时，多久没数据算超时 默认 300000（5 分钟）
	// 0 = 禁用（内部会转成 2147483647，因为各 SDK 把 0 当立即超时）
	// 两处用法：
	// 全局 HTTP 客户端（undici）：headersTimeout + bodyTimeout
	// 调模型 API：作为 streamSimple 的 timeoutMs，覆盖 OpenAI、Codex、llama.cpp 等 provider 的单次请求超时；Codex WebSocket 空闲等待也用它
	
	// /settings 里可选 30s / 1min / 2min / 5min / disabled。
	// 注意： 这是空闲超时，不是「整次对话总时长」。模型慢慢吐 token 时连接有数据，一般不会因这个断；卡住没响应才会超时。
	httpIdleTimeoutMs?: number;
	// WebSocket 握手/建连阶段超时（毫秒），只管「连上没」，不管后面流式多久
	// 未配置时 provider 侧默认 15000（15s）
	// 0 = 不限制建连等待
	// 主要给走 WebSocket 的 provider（如 OpenAI Codex Responses + transport: websocket）

	// websocketConnectTimeoutMs WS 握手能不能连上
	// httpIdleTimeoutMs 连上之后 HTTP/WS 流多久没数据
	websocketConnectTimeoutMs?: number;
}

/** Deep merge settings: project/overrides take precedence, nested objects merge recursively */
function deepMergeSettings(base: Settings, overrides: Settings): Settings {
	const result: Settings = { ...base };

	for (const key of Object.keys(overrides) as (keyof Settings)[]) {
		const overrideValue = overrides[key];
		const baseValue = base[key];

		if (overrideValue === undefined) {
			continue;
		}

		// For nested objects, merge recursively
		if (
			typeof overrideValue === "object" &&
			overrideValue !== null &&
			!Array.isArray(overrideValue) &&
			typeof baseValue === "object" &&
			baseValue !== null &&
			!Array.isArray(baseValue)
		) {
			// 两边都是普通对象（非数组）→ 浅合并
			(result as Record<string, unknown>)[key] = { ...baseValue, ...overrideValue };
		} else {
			// 其他（原始值、数组）→ 直接覆盖
			(result as Record<string, unknown>)[key] = overrideValue;
		}
	}

	return result;
}

function parseTimeoutSetting(value: unknown, settingName: string): number | undefined {
	const timeoutMs = parseHttpIdleTimeoutMs(value);
	if (timeoutMs !== undefined) {
		return timeoutMs;
	}
	if (value !== undefined) {
		throw new Error(`Invalid ${settingName} setting: ${String(value)}`);
	}
	return undefined;
}

export type SettingsScope = "global" | "project";

export interface SettingsManagerCreateOptions {
	projectTrusted?: boolean;
}

export interface SettingsStorage {
	// 加锁保证并发读写的原子性
	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void;
}

export interface SettingsError {
	scope: SettingsScope;
	error: Error;
}

export class FileSettingsStorage implements SettingsStorage {
	private globalSettingsPath: string;
	private projectSettingsPath: string;

	constructor(cwd: string, agentDir: string) {
		const resolvedCwd = resolvePath(cwd);
		const resolvedAgentDir = resolvePath(agentDir);
		this.globalSettingsPath = join(resolvedAgentDir, "settings.json");
		this.projectSettingsPath = join(resolvedCwd, CONFIG_DIR_NAME, "settings.json");
	}

	// 加锁保证并发读写的原子性
	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;
		// 重试多次，直到加锁成功或达到最大重试次数
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// Sleep synchronously to avoid changing callers to async.
				}
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire settings lock");
	}

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;
		const dir = dirname(path);

		let release: (() => void) | undefined;
		try {
			// 检查文件是否存在
			const fileExists = existsSync(path);
			if (fileExists) {
				// 加锁
				release = this.acquireLockSyncWithRetry(path);
			}
			// 读取文件内容
			const current = fileExists ? readFileSync(path, "utf-8") : undefined;
			// 调用回调函数，传入当前内容
			const next = fn(current);
			// 如果回调函数返回了新的内容
			if (next !== undefined) {
				// 如果目录不存在，则创建目录
				if (!existsSync(dir)) {
					mkdirSync(dir, { recursive: true });
				}
				// 如果锁不存在，则加锁
				if (!release) {
					release = this.acquireLockSyncWithRetry(path);
				}
				// 写入文件
				writeFileSync(path, next, "utf-8");
			}
		} finally {
			// 释放锁
			if (release) {
				release();
			}
		}
	}
}

export class InMemorySettingsStorage implements SettingsStorage {
	private global: string | undefined;
	private project: string | undefined;
	// 设计意图：加锁保证并发读写的原子性
	// 实际上：单进程测试用，没有并发写同一文件的问题，不需要文件锁
	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const current = scope === "global" ? this.global : this.project;
		// 调用回调函数，传入当前内容
		const next = fn(current);
		// 如果回调函数返回了新的内容
		if (next !== undefined) {
			// 如果 scope 是 global，则更新 global
			if (scope === "global") {
				this.global = next;
			} else {
				// 如果 scope 是 project，则更新 project
				this.project = next;
			}
		}
	}
}

// pi 的配置中心，读、合并、改、写用户设置
export class SettingsManager {
	private storage: SettingsStorage; // 存储后端，文件或内存
	private globalSettings: Settings; // 全局设置
	private projectSettings: Settings; // 项目设置
	private settings: Settings; // 合并后的设置
	private projectTrusted: boolean; // 交互模式首次进项目，弹 trust 提示框是否信任当前项目
	// 用户随时可能在session 里通过 /settings 里改选项
	private modifiedFields = new Set<keyof Settings>(); // 追踪会话期间被修改的全局字段
	private modifiedNestedFields = new Map<keyof Settings, Set<string>>(); // 追踪会话期间被修改的全局嵌套字段
	private modifiedProjectFields = new Set<keyof Settings>(); // 追踪会话期间被修改的项目字段
	private modifiedProjectNestedFields = new Map<keyof Settings, Set<string>>(); // 追踪会话期间被修改的项目嵌套字段
	private globalSettingsLoadError: Error | null = null; // 追踪/记录全局设置文件是否存在解析错误
	private projectSettingsLoadError: Error | null = null; // 追踪/记录项目设置文件是否存在解析错误
	private writeQueue: Promise<void> = Promise.resolve(); // 写入队列
	private errors: SettingsError[]; // 错误列表

	private constructor(
		storage: SettingsStorage,
		initialGlobal: Settings,
		initialProject: Settings,
		globalLoadError: Error | null = null,
		projectLoadError: Error | null = null,
		initialErrors: SettingsError[] = [],
		projectTrusted = true,
	) {
		this.storage = storage;
		this.globalSettings = initialGlobal;
		this.projectSettings = initialProject;
		this.projectTrusted = projectTrusted;
		this.globalSettingsLoadError = globalLoadError;
		this.projectSettingsLoadError = projectLoadError;
		this.errors = [...initialErrors];
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
	}

	/** 从磁盘文件创建 SettingsManager */
	static create(
		cwd: string,
		agentDir: string = getAgentDir(),
		options: SettingsManagerCreateOptions = {},
	): SettingsManager {
		const storage = new FileSettingsStorage(cwd, agentDir);
		return SettingsManager.fromStorage(storage, options);
	}

	/** 从任意存储后端创建 SettingsManager */
	static fromStorage(storage: SettingsStorage, options: SettingsManagerCreateOptions = {}): SettingsManager {
		const projectTrusted = options.projectTrusted ?? true;
		const globalLoad = SettingsManager.tryLoadFromStorage(storage, "global");
		// projectTrusted: false 时不读项目 settings，当作 {}
		// 不信任项目时不加载 <cwd>/.pi/settings.json，只读全局 settings。
		const projectLoad = SettingsManager.tryLoadFromStorage(storage, "project", projectTrusted);
		const initialErrors: SettingsError[] = [];
		if (globalLoad.error) {
			initialErrors.push({ scope: "global", error: globalLoad.error });
		}
		if (projectLoad.error) {
			initialErrors.push({ scope: "project", error: projectLoad.error });
		}
		// 用上面查到的全局、项目 settings，以及错误列表，创建 SettingsManager
		// SettingsManager 的构造函数内有根据 projectTrusted 合并全局、项目 settings 的逻辑
		return new SettingsManager(
			storage,
			globalLoad.settings,
			projectLoad.settings,
			globalLoad.error,
			projectLoad.error,
			initialErrors,
			projectTrusted,
		);
	}

	/** Create an in-memory SettingsManager (no file I/O) */
	static inMemory(settings: Partial<Settings> = {}, options: SettingsManagerCreateOptions = {}): SettingsManager {
		const storage = new InMemorySettingsStorage();
		const initialSettings = SettingsManager.migrateSettings(structuredClone(settings) as Record<string, unknown>);
		storage.withLock("global", () => JSON.stringify(initialSettings, null, 2));
		return SettingsManager.fromStorage(storage, options);
	}

	private static loadFromStorage(storage: SettingsStorage, scope: SettingsScope, projectTrusted = true): Settings {
		if (scope === "project" && !projectTrusted) {
			return {};
		}

		let content: string | undefined;
		storage.withLock(scope, (current) => {
			content = current;
			return undefined;
		});

		if (!content) {
			return {};
		}
		const settings = JSON.parse(content);
		return SettingsManager.migrateSettings(settings);
	}

	private static tryLoadFromStorage(
		storage: SettingsStorage,
		scope: SettingsScope,
		projectTrusted = true,
	): { settings: Settings; error: Error | null } {
		try {
			return { settings: SettingsManager.loadFromStorage(storage, scope, projectTrusted), error: null };
		} catch (error) {
			return { settings: {}, error: error as Error };
		}
	}

	/** Migrate old settings format to new format */
	private static migrateSettings(settings: Record<string, unknown>): Settings {
		// Migrate queueMode -> steeringMode
		if ("queueMode" in settings && !("steeringMode" in settings)) {
			settings.steeringMode = settings.queueMode;
			delete settings.queueMode;
		}

		// Migrate legacy websockets boolean -> transport enum
		if (!("transport" in settings) && typeof settings.websockets === "boolean") {
			settings.transport = settings.websockets ? "websocket" : "sse";
			delete settings.websockets;
		}

		// Migrate old skills object format to new array format
		if (
			"skills" in settings &&
			typeof settings.skills === "object" &&
			settings.skills !== null &&
			!Array.isArray(settings.skills)
		) {
			const skillsSettings = settings.skills as {
				enableSkillCommands?: boolean;
				customDirectories?: unknown;
			};
			if (skillsSettings.enableSkillCommands !== undefined && settings.enableSkillCommands === undefined) {
				settings.enableSkillCommands = skillsSettings.enableSkillCommands;
			}
			if (Array.isArray(skillsSettings.customDirectories) && skillsSettings.customDirectories.length > 0) {
				settings.skills = skillsSettings.customDirectories;
			} else {
				delete settings.skills;
			}
		}

		// Migrate retry.maxDelayMs -> retry.provider.maxRetryDelayMs
		if (
			"retry" in settings &&
			typeof settings.retry === "object" &&
			settings.retry !== null &&
			!Array.isArray(settings.retry)
		) {
			const retrySettings = settings.retry as Record<string, unknown>;
			const providerSettings =
				typeof retrySettings.provider === "object" && retrySettings.provider !== null
					? (retrySettings.provider as Record<string, unknown>)
					: undefined;
			if (
				typeof retrySettings.maxDelayMs === "number" &&
				(providerSettings?.maxRetryDelayMs === undefined || providerSettings?.maxRetryDelayMs === null)
			) {
				retrySettings.provider = {
					...(providerSettings ?? {}),
					maxRetryDelayMs: retrySettings.maxDelayMs,
				};
			}
			delete retrySettings.maxDelayMs;
		}

		return settings as Settings;
	}

	getGlobalSettings(): Settings {
		return structuredClone(this.globalSettings);
	}

	getProjectSettings(): Settings {
		return structuredClone(this.projectSettings);
	}

	isProjectTrusted(): boolean {
		return this.projectTrusted;
	}

	setProjectTrusted(trusted: boolean): void {
		if (this.projectTrusted === trusted) {
			return;
		}

		this.projectTrusted = trusted;
		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();

		if (!trusted) {
			this.projectSettings = {};
			this.projectSettingsLoadError = null;
			this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
			return;
		}

		const projectLoad = SettingsManager.tryLoadFromStorage(this.storage, "project", trusted);
		this.projectSettings = projectLoad.settings;
		this.projectSettingsLoadError = projectLoad.error;
		if (projectLoad.error) {
			this.recordError("project", projectLoad.error);
		}
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
	}

	async reload(): Promise<void> {
		await this.writeQueue;
		const globalLoad = SettingsManager.tryLoadFromStorage(this.storage, "global");
		if (!globalLoad.error) {
			this.globalSettings = globalLoad.settings;
			this.globalSettingsLoadError = null;
		} else {
			this.globalSettingsLoadError = globalLoad.error;
			this.recordError("global", globalLoad.error);
		}

		this.modifiedFields.clear();
		this.modifiedNestedFields.clear();
		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();

		const projectLoad = SettingsManager.tryLoadFromStorage(this.storage, "project", this.projectTrusted);
		if (!projectLoad.error) {
			this.projectSettings = projectLoad.settings;
			this.projectSettingsLoadError = null;
		} else {
			this.projectSettingsLoadError = projectLoad.error;
			this.recordError("project", projectLoad.error);
		}

		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
	}

	/** Apply additional overrides on top of current settings */
	applyOverrides(overrides: Partial<Settings>): void {
		this.settings = deepMergeSettings(this.settings, overrides);
	}

	/** Mark a global field as modified during this session */
	private markModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedFields.add(field);
		if (nestedKey) {
			if (!this.modifiedNestedFields.has(field)) {
				this.modifiedNestedFields.set(field, new Set());
			}
			this.modifiedNestedFields.get(field)!.add(nestedKey);
		}
	}

	/** Mark a project field as modified during this session */
	private markProjectModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedProjectFields.add(field);
		if (nestedKey) {
			if (!this.modifiedProjectNestedFields.has(field)) {
				this.modifiedProjectNestedFields.set(field, new Set());
			}
			this.modifiedProjectNestedFields.get(field)!.add(nestedKey);
		}
	}

	private assertProjectTrustedForWrite(): void {
		if (!this.projectTrusted) {
			throw new Error("Project is not trusted; refusing to write project settings");
		}
	}

	private recordError(scope: SettingsScope, error: unknown): void {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		this.errors.push({ scope, error: normalizedError });
	}

	private clearModifiedScope(scope: SettingsScope): void {
		if (scope === "global") {
			this.modifiedFields.clear();
			this.modifiedNestedFields.clear();
			return;
		}

		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();
	}

	private enqueueWrite(scope: SettingsScope, task: () => void): void {
		this.writeQueue = this.writeQueue
			.then(() => {
				if (scope === "project") {
					this.assertProjectTrustedForWrite();
				}
				task();
				this.clearModifiedScope(scope);
			})
			.catch((error) => {
				this.recordError(scope, error);
			});
	}

	private cloneModifiedNestedFields(source: Map<keyof Settings, Set<string>>): Map<keyof Settings, Set<string>> {
		const snapshot = new Map<keyof Settings, Set<string>>();
		for (const [key, value] of source.entries()) {
			snapshot.set(key, new Set(value));
		}
		return snapshot;
	}

	private persistScopedSettings(
		scope: SettingsScope,
		snapshotSettings: Settings,
		modifiedFields: Set<keyof Settings>,
		modifiedNestedFields: Map<keyof Settings, Set<string>>,
	): void {
		this.storage.withLock(scope, (current) => {
			const currentFileSettings = current
				? SettingsManager.migrateSettings(JSON.parse(current) as Record<string, unknown>)
				: {};
			const mergedSettings: Settings = { ...currentFileSettings };
			for (const field of modifiedFields) {
				const value = snapshotSettings[field];
				if (modifiedNestedFields.has(field) && typeof value === "object" && value !== null) {
					const nestedModified = modifiedNestedFields.get(field)!;
					const baseNested = (currentFileSettings[field] as Record<string, unknown>) ?? {};
					const inMemoryNested = value as Record<string, unknown>;
					const mergedNested = { ...baseNested };
					for (const nestedKey of nestedModified) {
						mergedNested[nestedKey] = inMemoryNested[nestedKey];
					}
					(mergedSettings as Record<string, unknown>)[field] = mergedNested;
				} else {
					(mergedSettings as Record<string, unknown>)[field] = value;
				}
			}

			return JSON.stringify(mergedSettings, null, 2);
		});
	}

	private save(): void {
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);

		if (this.globalSettingsLoadError) {
			return;
		}

		const snapshotGlobalSettings = structuredClone(this.globalSettings);
		const modifiedFields = new Set(this.modifiedFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedNestedFields);

		this.enqueueWrite("global", () => {
			this.persistScopedSettings("global", snapshotGlobalSettings, modifiedFields, modifiedNestedFields);
		});
	}

	private saveProjectSettings(settings: Settings): void {
		this.assertProjectTrustedForWrite();
		this.projectSettings = structuredClone(settings);
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);

		if (this.projectSettingsLoadError) {
			return;
		}

		const snapshotProjectSettings = structuredClone(this.projectSettings);
		const modifiedFields = new Set(this.modifiedProjectFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedProjectNestedFields);
		this.enqueueWrite("project", () => {
			this.persistScopedSettings("project", snapshotProjectSettings, modifiedFields, modifiedNestedFields);
		});
	}

	private updateProjectSettings(field: keyof Settings, update: (settings: Settings) => void): void {
		this.assertProjectTrustedForWrite();
		const projectSettings = structuredClone(this.projectSettings);
		update(projectSettings);
		this.markProjectModified(field);
		this.saveProjectSettings(projectSettings);
	}

	async flush(): Promise<void> {
		await this.writeQueue;
	}

	drainErrors(): SettingsError[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	getLastChangelogVersion(): string | undefined {
		return this.settings.lastChangelogVersion;
	}

	setLastChangelogVersion(version: string): void {
		this.globalSettings.lastChangelogVersion = version;
		this.markModified("lastChangelogVersion");
		this.save();
	}

	getSessionDir(): string | undefined {
		const sessionDir = this.settings.sessionDir;
		return sessionDir ? normalizePath(sessionDir) : sessionDir;
	}

	getDefaultProvider(): string | undefined {
		return this.settings.defaultProvider;
	}

	getDefaultModel(): string | undefined {
		return this.settings.defaultModel;
	}

	setDefaultProvider(provider: string): void {
		this.globalSettings.defaultProvider = provider;
		this.markModified("defaultProvider");
		this.save();
	}

	setDefaultModel(modelId: string): void {
		this.globalSettings.defaultModel = modelId;
		this.markModified("defaultModel");
		this.save();
	}

	setDefaultModelAndProvider(provider: string, modelId: string): void {
		this.globalSettings.defaultProvider = provider;
		this.globalSettings.defaultModel = modelId;
		this.markModified("defaultProvider");
		this.markModified("defaultModel");
		this.save();
	}

	getSteeringMode(): "all" | "one-at-a-time" {
		return this.settings.steeringMode || "one-at-a-time";
	}

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.globalSettings.steeringMode = mode;
		this.markModified("steeringMode");
		this.save();
	}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return this.settings.followUpMode || "one-at-a-time";
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.globalSettings.followUpMode = mode;
		this.markModified("followUpMode");
		this.save();
	}

	getThemeSetting(): string | undefined {
		const value = this.settings.theme;
		if (typeof value === "string") return value;
		return undefined;
	}

	getTheme(): string | undefined {
		const theme = this.getThemeSetting();
		return theme?.includes("/") ? undefined : theme;
	}

	setTheme(theme: string): void {
		this.globalSettings.theme = theme;
		this.markModified("theme");
		this.save();
	}

	getDefaultThinkingLevel(): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
		return this.settings.defaultThinkingLevel;
	}

	setDefaultThinkingLevel(level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"): void {
		this.globalSettings.defaultThinkingLevel = level;
		this.markModified("defaultThinkingLevel");
		this.save();
	}

	getTransport(): TransportSetting {
		return this.settings.transport ?? "auto";
	}

	setTransport(transport: TransportSetting): void {
		this.globalSettings.transport = transport;
		this.markModified("transport");
		this.save();
	}

	getCompactionEnabled(): boolean {
		return this.settings.compaction?.enabled ?? true;
	}

	setCompactionEnabled(enabled: boolean): void {
		if (!this.globalSettings.compaction) {
			this.globalSettings.compaction = {};
		}
		this.globalSettings.compaction.enabled = enabled;
		this.markModified("compaction", "enabled");
		this.save();
	}

	getCompactionReserveTokens(): number {
		return this.settings.compaction?.reserveTokens ?? 16384;
	}

	getCompactionKeepRecentTokens(): number {
		return this.settings.compaction?.keepRecentTokens ?? 20000;
	}

	getCompactionSettings(): { enabled: boolean; reserveTokens: number; keepRecentTokens: number } {
		return {
			enabled: this.getCompactionEnabled(),
			reserveTokens: this.getCompactionReserveTokens(),
			keepRecentTokens: this.getCompactionKeepRecentTokens(),
		};
	}

	getBranchSummarySettings(): { reserveTokens: number; skipPrompt: boolean } {
		return {
			reserveTokens: this.settings.branchSummary?.reserveTokens ?? 16384,
			skipPrompt: this.settings.branchSummary?.skipPrompt ?? false,
		};
	}

	getBranchSummarySkipPrompt(): boolean {
		return this.settings.branchSummary?.skipPrompt ?? false;
	}

	getRetryEnabled(): boolean {
		return this.settings.retry?.enabled ?? true;
	}

	setRetryEnabled(enabled: boolean): void {
		if (!this.globalSettings.retry) {
			this.globalSettings.retry = {};
		}
		this.globalSettings.retry.enabled = enabled;
		this.markModified("retry", "enabled");
		this.save();
	}

	getRetrySettings(): { enabled: boolean; maxRetries: number; baseDelayMs: number } {
		return {
			enabled: this.getRetryEnabled(),
			maxRetries: this.settings.retry?.maxRetries ?? 3,
			baseDelayMs: this.settings.retry?.baseDelayMs ?? 2000,
		};
	}

	getHttpIdleTimeoutMs(): number {
		return parseTimeoutSetting(this.settings.httpIdleTimeoutMs, "httpIdleTimeoutMs") ?? DEFAULT_HTTP_IDLE_TIMEOUT_MS;
	}

	setHttpIdleTimeoutMs(timeoutMs: number): void {
		if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
			throw new Error(`Invalid httpIdleTimeoutMs setting: ${String(timeoutMs)}`);
		}
		this.globalSettings.httpIdleTimeoutMs = Math.floor(timeoutMs);
		this.markModified("httpIdleTimeoutMs");
		this.save();
	}

	getProviderRetrySettings(): { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs: number } {
		return {
			timeoutMs: this.settings.retry?.provider?.timeoutMs,
			maxRetries: this.settings.retry?.provider?.maxRetries,
			maxRetryDelayMs: this.settings.retry?.provider?.maxRetryDelayMs ?? 60000,
		};
	}

	getWebSocketConnectTimeoutMs(): number | undefined {
		return parseTimeoutSetting(this.settings.websocketConnectTimeoutMs, "websocketConnectTimeoutMs");
	}

	getHideThinkingBlock(): boolean {
		return this.settings.hideThinkingBlock ?? false;
	}

	getExternalEditorCommand(): string | undefined {
		const configuredEditor = this.settings.externalEditor;
		if (typeof configuredEditor === "string" && configuredEditor.trim() !== "") {
			return configuredEditor;
		}
		const environmentEditor = process.env.VISUAL || process.env.EDITOR;
		if (environmentEditor) {
			return environmentEditor;
		}
		return process.platform === "win32" ? "notepad" : "nano";
	}

	setHideThinkingBlock(hide: boolean): void {
		this.globalSettings.hideThinkingBlock = hide;
		this.markModified("hideThinkingBlock");
		this.save();
	}

	getShellPath(): string | undefined {
		return this.settings.shellPath;
	}

	setShellPath(path: string | undefined): void {
		this.globalSettings.shellPath = path;
		this.markModified("shellPath");
		this.save();
	}

	getQuietStartup(): boolean {
		return this.settings.quietStartup ?? false;
	}

	setQuietStartup(quiet: boolean): void {
		this.globalSettings.quietStartup = quiet;
		this.markModified("quietStartup");
		this.save();
	}

	getDefaultProjectTrust(): DefaultProjectTrust {
		const value = this.globalSettings.defaultProjectTrust;
		return value === "always" || value === "never" ? value : "ask";
	}

	setDefaultProjectTrust(defaultProjectTrust: DefaultProjectTrust): void {
		this.globalSettings.defaultProjectTrust = defaultProjectTrust;
		this.markModified("defaultProjectTrust");
		this.save();
	}

	getShellCommandPrefix(): string | undefined {
		return this.settings.shellCommandPrefix;
	}

	setShellCommandPrefix(prefix: string | undefined): void {
		this.globalSettings.shellCommandPrefix = prefix;
		this.markModified("shellCommandPrefix");
		this.save();
	}

	getNpmCommand(): string[] | undefined {
		return this.settings.npmCommand ? [...this.settings.npmCommand] : undefined;
	}

	setNpmCommand(command: string[] | undefined): void {
		this.globalSettings.npmCommand = command ? [...command] : undefined;
		this.markModified("npmCommand");
		this.save();
	}

	getCollapseChangelog(): boolean {
		return this.settings.collapseChangelog ?? false;
	}

	setCollapseChangelog(collapse: boolean): void {
		this.globalSettings.collapseChangelog = collapse;
		this.markModified("collapseChangelog");
		this.save();
	}

	getEnableInstallTelemetry(): boolean {
		return this.settings.enableInstallTelemetry ?? true;
	}

	setEnableInstallTelemetry(enabled: boolean): void {
		this.globalSettings.enableInstallTelemetry = enabled;
		this.markModified("enableInstallTelemetry");
		this.save();
	}

	getEnableAnalytics(): boolean {
		return this.settings.enableAnalytics ?? false;
	}

	getTrackingId(): string | undefined {
		return this.settings.trackingId;
	}

	/** Set the analytics opt-in preference; generates a tracking identifier on first opt-in */
	setEnableAnalytics(enabled: boolean): void {
		this.globalSettings.enableAnalytics = enabled;
		this.markModified("enableAnalytics");
		if (enabled && !this.globalSettings.trackingId) {
			this.globalSettings.trackingId = randomUUID();
			this.markModified("trackingId");
		}
		this.save();
	}

	getPackages(): PackageSource[] {
		return [...(this.settings.packages ?? [])];
	}

	setPackages(packages: PackageSource[]): void {
		this.globalSettings.packages = packages;
		this.markModified("packages");
		this.save();
	}

	setProjectPackages(packages: PackageSource[]): void {
		this.updateProjectSettings("packages", (settings) => {
			settings.packages = packages;
		});
	}

	getExtensionPaths(): string[] {
		return [...(this.settings.extensions ?? [])];
	}

	setExtensionPaths(paths: string[]): void {
		this.globalSettings.extensions = paths;
		this.markModified("extensions");
		this.save();
	}

	setProjectExtensionPaths(paths: string[]): void {
		this.updateProjectSettings("extensions", (settings) => {
			settings.extensions = paths;
		});
	}

	getSkillPaths(): string[] {
		return [...(this.settings.skills ?? [])];
	}

	setSkillPaths(paths: string[]): void {
		this.globalSettings.skills = paths;
		this.markModified("skills");
		this.save();
	}

	setProjectSkillPaths(paths: string[]): void {
		this.updateProjectSettings("skills", (settings) => {
			settings.skills = paths;
		});
	}

	getPromptTemplatePaths(): string[] {
		return [...(this.settings.prompts ?? [])];
	}

	setPromptTemplatePaths(paths: string[]): void {
		this.globalSettings.prompts = paths;
		this.markModified("prompts");
		this.save();
	}

	setProjectPromptTemplatePaths(paths: string[]): void {
		this.updateProjectSettings("prompts", (settings) => {
			settings.prompts = paths;
		});
	}

	getThemePaths(): string[] {
		return [...(this.settings.themes ?? [])];
	}

	setThemePaths(paths: string[]): void {
		this.globalSettings.themes = paths;
		this.markModified("themes");
		this.save();
	}

	setProjectThemePaths(paths: string[]): void {
		this.updateProjectSettings("themes", (settings) => {
			settings.themes = paths;
		});
	}

	getEnableSkillCommands(): boolean {
		return this.settings.enableSkillCommands ?? true;
	}

	setEnableSkillCommands(enabled: boolean): void {
		this.globalSettings.enableSkillCommands = enabled;
		this.markModified("enableSkillCommands");
		this.save();
	}

	getThinkingBudgets(): ThinkingBudgetsSettings | undefined {
		return this.settings.thinkingBudgets;
	}

	getShowImages(): boolean {
		return this.settings.terminal?.showImages ?? true;
	}

	setShowImages(show: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.showImages = show;
		this.markModified("terminal", "showImages");
		this.save();
	}

	getImageWidthCells(): number {
		const width = this.settings.terminal?.imageWidthCells;
		if (typeof width !== "number" || !Number.isFinite(width)) {
			return 60;
		}
		return Math.max(1, Math.floor(width));
	}

	setImageWidthCells(width: number): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.imageWidthCells = Math.max(1, Math.floor(width));
		this.markModified("terminal", "imageWidthCells");
		this.save();
	}

	getClearOnShrink(): boolean {
		// Settings takes precedence, then env var, then default false
		if (this.settings.terminal?.clearOnShrink !== undefined) {
			return this.settings.terminal.clearOnShrink;
		}
		return process.env.PI_CLEAR_ON_SHRINK === "1";
	}

	setClearOnShrink(enabled: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.clearOnShrink = enabled;
		this.markModified("terminal", "clearOnShrink");
		this.save();
	}

	getShowTerminalProgress(): boolean {
		return this.settings.terminal?.showTerminalProgress ?? false;
	}

	setShowTerminalProgress(enabled: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.showTerminalProgress = enabled;
		this.markModified("terminal", "showTerminalProgress");
		this.save();
	}

	getImageAutoResize(): boolean {
		return this.settings.images?.autoResize ?? true;
	}

	setImageAutoResize(enabled: boolean): void {
		if (!this.globalSettings.images) {
			this.globalSettings.images = {};
		}
		this.globalSettings.images.autoResize = enabled;
		this.markModified("images", "autoResize");
		this.save();
	}

	getBlockImages(): boolean {
		return this.settings.images?.blockImages ?? false;
	}

	setBlockImages(blocked: boolean): void {
		if (!this.globalSettings.images) {
			this.globalSettings.images = {};
		}
		this.globalSettings.images.blockImages = blocked;
		this.markModified("images", "blockImages");
		this.save();
	}

	getEnabledModels(): string[] | undefined {
		return this.settings.enabledModels;
	}

	setEnabledModels(patterns: string[] | undefined): void {
		this.globalSettings.enabledModels = patterns;
		this.markModified("enabledModels");
		this.save();
	}

	getDoubleEscapeAction(): "fork" | "tree" | "none" {
		return this.settings.doubleEscapeAction ?? "tree";
	}

	setDoubleEscapeAction(action: "fork" | "tree" | "none"): void {
		this.globalSettings.doubleEscapeAction = action;
		this.markModified("doubleEscapeAction");
		this.save();
	}

	getTreeFilterMode(): "default" | "no-tools" | "user-only" | "labeled-only" | "all" {
		const mode = this.settings.treeFilterMode;
		const valid = ["default", "no-tools", "user-only", "labeled-only", "all"];
		return mode && valid.includes(mode) ? mode : "default";
	}

	setTreeFilterMode(mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all"): void {
		this.globalSettings.treeFilterMode = mode;
		this.markModified("treeFilterMode");
		this.save();
	}

	getShowHardwareCursor(): boolean {
		return this.settings.showHardwareCursor ?? process.env.PI_HARDWARE_CURSOR === "1";
	}

	setShowHardwareCursor(enabled: boolean): void {
		this.globalSettings.showHardwareCursor = enabled;
		this.markModified("showHardwareCursor");
		this.save();
	}

	getEditorPaddingX(): number {
		return this.settings.editorPaddingX ?? 0;
	}

	setEditorPaddingX(padding: number): void {
		this.globalSettings.editorPaddingX = Math.max(0, Math.min(3, Math.floor(padding)));
		this.markModified("editorPaddingX");
		this.save();
	}

	getOutputPad(): 0 | 1 {
		return this.settings.outputPad === 0 ? 0 : 1;
	}

	setOutputPad(padding: 0 | 1): void {
		this.globalSettings.outputPad = padding;
		this.markModified("outputPad");
		this.save();
	}

	getAutocompleteMaxVisible(): number {
		return this.settings.autocompleteMaxVisible ?? 5;
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.globalSettings.autocompleteMaxVisible = Math.max(3, Math.min(20, Math.floor(maxVisible)));
		this.markModified("autocompleteMaxVisible");
		this.save();
	}

	getCodeBlockIndent(): string {
		return this.settings.markdown?.codeBlockIndent ?? "  ";
	}

	getWarnings(): WarningSettings {
		return { ...(this.settings.warnings ?? {}) };
	}

	setWarnings(warnings: WarningSettings): void {
		this.globalSettings.warnings = { ...warnings };
		this.markModified("warnings");
		this.save();
	}
}
