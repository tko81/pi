#!/usr/bin/env node
/**
 * 当这个文件被直接执行时，使用 node 来运行它
 * 当你全局安装这个包：npm install -g @earendil-works/pi-coding-agent
 * npm 会在全局命令目录中创建一个名为 pi 的入口，指向：@earendil-works/pi-coding-agent/dist/cli.js
 * 所以终端输入：pi
 * Shell 的执行过程是：
 * - 在 PATH 中查找名为 pi 的可执行文件
 * - 找到 npm 创建的 pi 命令入口
 * - 入口指向 dist/cli.js
 * - 操作系统读取 dist/cli.js 第一行
 * - #!/usr/bin/env node
 * - 在 PATH 中找到 node
 * - Node.js 执行 dist/cli.js
 */
import { APP_NAME } from "./config.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { main } from "./main.ts";

// 完成基础初始化：设置进程标题和环境变量
process.title = APP_NAME;
process.env.PI_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

/* 
配置全局 HTTP 请求层
它主要负责三件事：
1. 让 HTTP 请求支持环境变量代理
2. 设置流式请求的空闲超时
3. 统一项目使用的 fetch 和 Undici 版本
这里的 dispatcher 可以理解为 Undici 的全局 HTTP 请求调度器。后续 Provider SDK 调用 fetch() 时，底层的连接、代理和超时由它管理 
*/
configureHttpDispatcher();

// 真正进入应用启动流程
main(process.argv.slice(2));
