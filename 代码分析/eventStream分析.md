[event-stream.ts](/Users/andyyywang/Desktop/code/pi-1/packages/ai/src/utils/event-stream.ts) 的作用可以简单概括为：

> 在 LLM 一边生成内容、一边产生事件时，负责缓存和传递这些事件，并在生成结束后提供完整的最终消息。

它解决的是典型的“生产者速度和消费者速度不一致”问题。

```text
LLM / Provider             Agent
事件生产者                  事件消费者

push(start)      ───────→  for await 读取
push(text_delta) ───────→  更新界面
push(text_delta) ───────→  更新界面
push(done)       ───────→  结束遍历

完整消息          ←──────  await stream.result()
```

## 核心能力

这个文件主要提供两个类：

```ts
EventStream<T, R>
AssistantMessageEventStream
```

### `EventStream<T, R>`

通用异步事件流。

- `T`：流中每个事件的类型。
- `R`：整个流最终结果的类型。

它提供四个主要操作：

```ts
stream.push(event);
```

生产者推入一个事件。

```ts
for await (const event of stream) {
  // 消费每个事件
}
```

消费者逐个读取流式事件。

```ts
stream.end(result);
```

生产者主动结束事件流。

```ts
const result = await stream.result();
```

获取整个流的最终结果。

### `AssistantMessageEventStream`

LLM assistant 响应专用的事件流：

```ts
EventStream<
  AssistantMessageEvent,
  AssistantMessage
>
```

也就是：

```text
流式过程 → AssistantMessageEvent
最终结果 → AssistantMessage
```

它规定：

```ts
event.type === "done" ||
event.type === "error"
```

表示事件流结束。

---



## 三个最重要的内部状态

虽然语法看起来复杂，但核心只有三个状态。

### `queue`

```ts
private queue: T[] = [];
```

事件已经产生，但消费者还没有读取时，暂存在这里：

```text
生产者快，消费者慢
→ 事件放进 queue
```



### `waiting`

```ts
private waiting:
  ((value: IteratorResult<T>) => void)[] = [];
```

消费者已经请求下一个事件，但事件还没有产生时，把消费者对应 Promise 的 `resolve` 暂存在这里：

```text
消费者快，生产者慢
→ 消费者的 resolve 放进 waiting
```



### `done`

```ts
private done = false;
```

记录流是否已经结束：

```text
false → 后面还可能有事件
true  → 不再接受新事件
```

因此核心机制就是：

```text
事件先来 → 放进 queue
消费者先来 → 放进 waiting
两者相遇 → 直接把事件交给消费者
```

---



## `push()` 做什么

```ts
push(event: T): void
```

逻辑可以简化成：

```ts
push(event) {
  if (已经结束) return;

  if (这是最终事件) {
    标记结束;
    保存最终结果;
  }

  if (有消费者正在等待) {
    直接把事件交给消费者;
  } else {
    把事件放进队列;
  }
}
```

也就是：

```text
push(event)
   ├─ waiting 中有人 → 直接唤醒消费者
   └─ waiting 为空   → event 放入 queue
```

---



## `for await...of` 做什么

这部分由：

```ts
async *[Symbol.asyncIterator]()
```

实现。

这是一种 JavaScript 特殊协议，表示该对象可以异步遍历：

```ts
for await (const event of stream) {
  console.log(event);
}
```

它的逻辑可以简化为：

```ts
while (true) {
  if (队列有事件) {
    返回最早的事件;
  } else if (流已结束) {
    结束循环;
  } else {
    等待生产者 push 新事件;
  }
}
```

因此消费者不需要自己轮询：

```ts
while (true) {
  // 有新事件了吗？
}
```

而是没有事件时自动暂停，有事件时自动恢复。

---



## `result()` 做什么

除了逐个读取事件，调用者通常还需要最后的完整消息：

```ts
const finalMessage = await stream.result();
```

因此内部创建了另一个 Promise：

```ts
this.finalResultPromise = new Promise((resolve) => {
  this.resolveFinalResult = resolve;
});
```

遇到最终事件时：

```ts
this.resolveFinalResult(
  this.extractResult(event)
);
```

于是 `result()` 返回的 Promise 完成。

所以一个流同时支持两种消费方式：

```ts
for await (const event of stream)
```

关注生成过程，例如流式更新 UI。

```ts
await stream.result()
```

只关注最终完整结果。

---



## 实际 LLM 流程

假设模型生成“你好”：

```ts
stream.push({
  type: "start",
  partial: emptyMessage,
});

stream.push({
  type: "text_delta",
  delta: "你",
  partial: messageWithNi,
});

stream.push({
  type: "text_delta",
  delta: "好",
  partial: messageWithNiHao,
});

stream.push({
  type: "done",
  message: finalMessage,
});
```

Agent 可以这样消费：

```ts
for await (const event of stream) {
  switch (event.type) {
    case "text_delta":
      updateUI(event.delta);
      break;

    case "done":
      console.log("生成完成");
      break;
  }
}
```

然后获取完整消息：

```ts
const finalMessage = await stream.result();
```

---



## 为什么不用普通数组

普通数组只能保存“已经产生”的数据：

```ts
const events = [];
```

但 LLM 事件是在未来陆续到来的。消费者需要：

- 没事件时暂停；
- 新事件到达时自动恢复；
- 处理生产者和消费者速度差；
- 知道事件流何时结束；
- 获取最终完整结果。

`EventStream` 把这些异步协调逻辑统一封装起来。

## 最简心智模型

可以暂时忽略复杂的泛型和异步迭代器语法，把它理解成一个“异步传送带”：

```text
生产者 push()
      ↓
   EventStream
   ├─ queue：暂存货物
   ├─ waiting：等待货物的人
   └─ done：传送带是否停止
      ↓
消费者 for await
```

同时旁边还有一条快速通道：

```text
stream.result()
→ 不关心中间事件，只等待最终完整结果
```

一句话总结：这个文件把 LLM 的流式回调包装成可用 `for await...of` 消费的异步事件流，并同时提供 `result()` 获取最终完整 Assistant 消息。复杂的语法主要来自 TypeScript 泛型、Promise 和异步迭代器，核心逻辑其实就是“事件先到就排队，消费者先到就等待”。