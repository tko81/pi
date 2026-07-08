/**
 * 内置工具渲染示例——为内置工具自定义展示
 *
 * 演示如何在不改变行为的前提下覆盖内置工具（read、bash、edit、write）的渲染。
 * 每个工具以相同名称重新注册：执行委托给原实现，同时提供紧凑的自定义
 * renderCall/renderResult。
 *
 * 适用于希望工具输出更简洁、或只突出特定信息的用户（例如 edit 仅显示 diff 统计，
 * bash 仅显示退出码）。
 *
 * 工作原理：
 * - 用与内置工具相同的名称调用 registerTool() 会完全替换该工具
 * - 通过 createReadTool() 等创建原工具实例，并将 execute() 委托给它们
 * - renderCall() 控制工具被调用时的展示
 * - renderResult() 控制执行完成后的展示
 * - renderShell: "self" 让工具自行渲染外层 shell，而非使用 ToolExecutionComponent 的默认框线 shell
 * - renderResult 中的 `expanded` 表示用户是否已展开工具输出（ctrl+e 或点击）
 *
 * 用法：
 *   pi -e ./built-in-tool-renderer.ts
 */

import type { BashToolDetails, EditToolDetails, ExtensionAPI, ReadToolDetails } from "@earendil-works/pi-coding-agent";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();

	// --- Read tool: show path and line count ---
	const originalRead = createReadTool(cwd);
	pi.registerTool({
		name: "read",
		label: "read",
		description: originalRead.description,
		parameters: originalRead.parameters,

		async execute(toolCallId, params, signal, onUpdate) {
			return originalRead.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("read "));
			text += theme.fg("accent", args.path);
			if (args.offset || args.limit) {
				const parts: string[] = [];
				if (args.offset) parts.push(`offset=${args.offset}`);
				if (args.limit) parts.push(`limit=${args.limit}`);
				text += theme.fg("dim", ` (${parts.join(", ")})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) return new Text(theme.fg("warning", "Reading..."), 0, 0);

			const details = result.details as ReadToolDetails | undefined;
			const content = result.content[0];

			if (content?.type === "image") {
				return new Text(theme.fg("success", "Image loaded"), 0, 0);
			}

			if (content?.type !== "text") {
				return new Text(theme.fg("error", "No content"), 0, 0);
			}

			const lineCount = content.text.split("\n").length;
			let text = theme.fg("success", `${lineCount} lines`);

			if (details?.truncation?.truncated) {
				text += theme.fg("warning", ` (truncated from ${details.truncation.totalLines})`);
			}

			if (expanded) {
				const lines = content.text.split("\n").slice(0, 15);
				for (const line of lines) {
					text += `\n${theme.fg("dim", line)}`;
				}
				if (lineCount > 15) {
					text += `\n${theme.fg("muted", `... ${lineCount - 15} more lines`)}`;
				}
			}

			return new Text(text, 0, 0);
		},
	});

	// --- Bash tool: show command and exit code ---
	const originalBash = createBashTool(cwd);
	pi.registerTool({
		name: "bash",
		label: "bash",
		description: originalBash.description,
		parameters: originalBash.parameters,

		async execute(toolCallId, params, signal, onUpdate) {
			return originalBash.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("$ "));
			const cmd = args.command.length > 80 ? `${args.command.slice(0, 77)}...` : args.command;
			text += theme.fg("accent", cmd);
			if (args.timeout) {
				text += theme.fg("dim", ` (timeout: ${args.timeout}s)`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);

			const details = result.details as BashToolDetails | undefined;
			const content = result.content[0];
			const output = content?.type === "text" ? content.text : "";

			const exitMatch = output.match(/exit code: (\d+)/);
			const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : null;
			const lineCount = output.split("\n").filter((l) => l.trim()).length;

			let text = "";
			if (exitCode === 0 || exitCode === null) {
				text += theme.fg("success", "done");
			} else {
				text += theme.fg("error", `exit ${exitCode}`);
			}
			text += theme.fg("dim", ` (${lineCount} lines)`);

			if (details?.truncation?.truncated) {
				text += theme.fg("warning", " [truncated]");
			}

			if (expanded) {
				const lines = output.split("\n").slice(0, 20);
				for (const line of lines) {
					text += `\n${theme.fg("dim", line)}`;
				}
				if (output.split("\n").length > 20) {
					text += `\n${theme.fg("muted", "... more output")}`;
				}
			}

			return new Text(text, 0, 0);
		},
	});

	// --- Edit tool: show path and diff stats ---
	const originalEdit = createEditTool(cwd);
	pi.registerTool({
		name: "edit",
		label: "edit",
		description: originalEdit.description,
		parameters: originalEdit.parameters,
		renderShell: "self",

		async execute(toolCallId, params, signal, onUpdate) {
			return originalEdit.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("edit "));
			text += theme.fg("accent", args.path);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) return new Text(theme.fg("warning", "Editing..."), 0, 0);

			const details = result.details as EditToolDetails | undefined;
			const content = result.content[0];

			if (content?.type === "text" && content.text.startsWith("Error")) {
				return new Text(theme.fg("error", content.text.split("\n")[0]), 0, 0);
			}

			if (!details?.diff) {
				return new Text(theme.fg("success", "Applied"), 0, 0);
			}

			// Count additions and removals from the diff
			const diffLines = details.diff.split("\n");
			let additions = 0;
			let removals = 0;
			for (const line of diffLines) {
				if (line.startsWith("+") && !line.startsWith("+++")) additions++;
				if (line.startsWith("-") && !line.startsWith("---")) removals++;
			}

			let text = theme.fg("success", `+${additions}`);
			text += theme.fg("dim", " / ");
			text += theme.fg("error", `-${removals}`);

			if (expanded) {
				for (const line of diffLines.slice(0, 30)) {
					if (line.startsWith("+") && !line.startsWith("+++")) {
						text += `\n${theme.fg("success", line)}`;
					} else if (line.startsWith("-") && !line.startsWith("---")) {
						text += `\n${theme.fg("error", line)}`;
					} else {
						text += `\n${theme.fg("dim", line)}`;
					}
				}
				if (diffLines.length > 30) {
					text += `\n${theme.fg("muted", `... ${diffLines.length - 30} more diff lines`)}`;
				}
			}

			return new Text(text, 0, 0);
		},
	});

	// --- Write tool: show path and size ---
	const originalWrite = createWriteTool(cwd);
	pi.registerTool({
		name: "write",
		label: "write",
		description: originalWrite.description,
		parameters: originalWrite.parameters,

		async execute(toolCallId, params, signal, onUpdate) {
			return originalWrite.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("write "));
			text += theme.fg("accent", args.path);
			const lineCount = args.content.split("\n").length;
			text += theme.fg("dim", ` (${lineCount} lines)`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { isPartial }, theme, _context) {
			if (isPartial) return new Text(theme.fg("warning", "Writing..."), 0, 0);

			const content = result.content[0];
			if (content?.type === "text" && content.text.startsWith("Error")) {
				return new Text(theme.fg("error", content.text.split("\n")[0]), 0, 0);
			}

			return new Text(theme.fg("success", "Written"), 0, 0);
		},
	});
}
