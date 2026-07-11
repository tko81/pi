import type { AssistantMessage, AssistantMessageEvent } from "../types.ts";

/* 
EventStream 主要处理的是 LLM 流式响应事件，不是负责理解或加工消息内容，这些事件描述的是“一条 assistant 消息如何逐步生成”
EventStream 解决的是典型的“生产者速度和消费者速度不一致”问题。
LLM / Provider             Agent
事件生产者                  事件消费者

push(start)      ───────→  for await 读取
push(text_delta) ───────→  更新界面
push(text_delta) ───────→  更新界面
push(done)       ───────→  结束遍历

完整消息          ←──────  await stream.result()


“可推送、可异步遍历、还能单独获取最终结果”的事件流
它连接了两类代码：
- 生产者：不断 push(event)
- 消费者：使用 for await...of 逐个读取
这里有两个泛型：
- T：流中每个事件的类型
- R：整个流的最终结果类型
- R = T：如果没有指定 R，默认和事件类型相同，EventStream<number> 等价于 EventStream<number, number>

而 Assistant 流是：
EventStream<
  AssistantMessageEvent,
  AssistantMessage
>
表示：
- 流中逐个产出 AssistantMessageEvent
- 最终结果是一条 AssistantMessage
*/
export class EventStream<T, R = T> implements AsyncIterable<T> {
	// 两者通常只有一边有内容：
	// - 事件先到   → 放进 queue
	// - 消费者先到 → 放进 waiting
	// 保存已经产生、但消费者还没读取的 event
	private queue: T[] = [];
	// 等待事件的消费者，这是一个数组，数组中的每一个元素都是一个函数（消费者）
	private waiting: ((value: IteratorResult<T>) => void)[] = [];
	// 记录事件流是否已经结束
	private done = false;
	// 最终结果 Promise，它允许调用者单独等待整个流的最终结果（类似于段式），这与事件遍历是两个不同的读取方式
	private finalResultPromise: Promise<R>;
	// 保存 Promise 的 resolve，用于在最终事件到达时完成 finalResultPromise
	// ! 是 TypeScript 的明确赋值断言，意思是：虽然没有在属性声明处赋值，但我保证构造函数中会赋值。
	// 否则 TypeScript 可能认为它未初始化。
	private resolveFinalResult!: (result: R) => void;
	// 判断完成与提取结果的函数，EventStream 本身不知道哪种事件代表结束，所以由创建者提供
	private isComplete: (event: T) => boolean;
	// 从最终事件中提取最终结果，这样 EventStream 不会和具体的 LLM 事件类型绑定
	private extractResult: (event: T) => R;

	constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
		this.isComplete = isComplete;
		this.extractResult = extractResult;
		// 创建一个名为 finalResultPromise 的 Promise，resolveFinalResult 是它的 resolve 函数
		this.finalResultPromise = new Promise((resolve) => {
			this.resolveFinalResult = resolve;
		});
	}

	// 生产者调用，将事件推入流
	push(event: T): void {
		// 如果流已经结束，忽略后续事件，避免结束后继续产生无效数据
		if (this.done) return;
		// 判断是不是最终事件，如果是则调用 resolveFinalResult 完成最终结果
		// 最终事件本身仍然会继续向消费者发送，不会因为设置了 done 就被丢弃
		if (this.isComplete(event)) {
			this.done = true;
			this.resolveFinalResult(this.extractResult(event));
		}

		// 把事件交给消费者，这里的 waiter 就是异步迭代器保存进去的 resolve
		const waiter = this.waiting.shift();
		// 消费者已经在等待，直接把事件交给最早等待的消费者
		if (waiter) {
			// 调用 resolve 函数，把事件传递给消费者
			waiter({ value: event, done: false });
		} else {
			// 消费者不在等待，把事件放进队列，等待消费者读取
			this.queue.push(event);
		}
	}

	// 生产者调用，结束流并提供最终结果，它适用于没有特定完成事件，或者上层需要强制关闭的情况
	end(result?: R): void {
		this.done = true;
		if (result !== undefined) {
			this.resolveFinalResult(result);
		}
		// 通知所有等待的消费者，流已经结束
		while (this.waiting.length > 0) {
			const waiter = this.waiting.shift()!;
			waiter({ value: undefined as any, done: true });
		}
	}

	// 这个方法会在对象被 for await ... of EventStream 遍历时自动调用
	// async：函数返回 Promise，内部可以 await
	// *：生成器函数（Generator），可以用 yield 逐个返回值，这里返回的是 AsyncIterator<T>，即异步迭代器
	// [Symbol.asyncIterator] —— 异步可迭代协议：这是 JavaScript 内置的 Symbol，任何对象只要实现了这个方法，就可以用 for await...of 遍历它
	// AsyncIterator<T> —— 它表示一个异步迭代器对象，其 next() 方法返回 Promise<IteratorResult<T>>
	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			// 如果已经有缓存事件，就取出最早的一项并交给消费者
			if (this.queue.length > 0) {
				// .shift()	数组方法：移除数组的第一个元素，并返回它
				// 这里的 ! 非空断言，告诉 TypeScript：因为已经检查了 length > 0，所以 shift() 不会返回 undefined。
				yield this.queue.shift()!;
			} else if (this.done) {
				// 如果流已经结束，直接返回，结束迭代
				return;
			} else {
				// 如果队列中没有事件，消费者还在等待，则创建一个 Promise 来等待消费者消费事件
				// 创建一个 Promise，它的完成值类型是 IteratorResult<T>，把 resolve 函数存进 waiting 数组，等待将来调用
				// 等待这个 Promise 被完成，然后取出结果
				// 步骤 1: 执行到这一行
				// ↓
				// 步骤 2: 创建 Promise，把 resolve 函数存入 waiting 数组
				// 		↓
				// 步骤 3: await 挂起，等待 Promise 完成
				// 		↓
				// 步骤 4: ... 时间流逝，其他代码在运行 ...
				// 		↓
				// 步骤 5: 某个地方从 waiting 数组中取出 resolve，并调用 resolve(data)
				// 		↓
				// 步骤 6: Promise 完成，await 恢复，result = data
				const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve));
				if (result.done) return;
				yield result.value;
			}
		}
	}

	// 获取最终结果，它返回构造函数中创建的 Promise
	// Promise<T> 中的 T 表示 Promise 成功完成后产生的结果类型，也就是 await promise 后得到的值的类型
	// 所以 await result() 会得到 R 类型的值
	result(): Promise<R> {
		return this.finalResultPromise;
	}
}

// 在通用 EventStream 上定义了 LLM 响应何时结束，以及如何提取最终 assistant 消息
// 这段代码定义了一个专门用于 LLM assistant 响应的事件流，它继承了前面的通用 EventStream<T, R>，并把泛型固定为 AssistantMessageEvent 和 AssistantMessage
// 也就是说：
// - 流式过程中不断产生 AssistantMessageEvent
// - 整个流结束后得到一个完整的 AssistantMessage
export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			// 判断事件是否结束的函数
			(event) => event.type === "done" || event.type === "error",
			// 从结束事件提取最终消息的函数
			(event) => {
				if (event.type === "done") {
					return event.message;
				} else if (event.type === "error") {
					// 这里的 event.error 从名称看容易误以为是 JavaScript 的 Error 对象，但它的类型应当也是 AssistantMessage，否则无法满足这个事件流的最终结果类型
					return event.error;
				}
				throw new Error("Unexpected event type for final result");
			},
		);
	}
}

/** Factory function for AssistantMessageEventStream (for use in extensions) */
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	return new AssistantMessageEventStream();
}
