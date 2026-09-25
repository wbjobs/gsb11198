# Web Worker 任务分发与异常恢复演示

零构建静态示例：主线程把 10 个简单计算任务分发到 3 个 Web Worker，并在故障发生时自动重试或切换到主线程分片备用方案。

## 运行

Worker 受同源策略限制，建议通过本地静态服务打开：

```bash
python3 -m http.server 8080
```

然后访问 `http://localhost:8080/`。

## 可注入异常

- **Worker 不支持**：跳过 Worker，全部任务进入主线程备用方案。
- **Worker 创建失败**：在 Worker 构造边界模拟失败，当前任务立即降级，其他 Worker 继续运行。
- **执行超时**：Worker 首次执行挂起，主线程在 1500ms 后终止 Worker 并重试。
- **消息丢失**：Worker 首次不回消息，由超时机制终止并重试。
- **消息乱序**：指定任务首次延迟，最终表格仍按任务 ID 显示，卡片角标展示真实到达顺序。
- **Worker 崩溃**：Worker 触发未捕获错误；任务重试，原 Worker 槽位自动替换恢复。
- **内存溢出**：Worker 返回可控的 `RangeError` 内存压力错误并重试；演示不会真实申请大量内存。

## 一致性

主线程和 Worker 共同加载 `src/compute.js`：

```text
f(n) = ((n × 7 + 13) mod 97) × n
```

每个完成结果都会再次用共享纯函数校验。Worker 结果和降级结果走同一份计算逻辑，最终“结果不一致”数量必须为 0。

## 主线程保护

备用方案不是长循环，而是在每个任务之间主动 `setTimeout` 让出主线程。页面同时用 `PerformanceObserver({ entryTypes: ["longtask"] })` 观察并绘制 long task。

## 文件

- `index.html`：DOM 控制面板、指标、日志和结果表。
- `src/worker.js`：Worker 任务执行与故障注入。
- `src/compute.js`：主线程和 Worker 共享的纯计算函数。
- `src/dispatcher.js`：Worker 池、超时终止、重试、崩溃恢复和降级队列。
- `src/visualizer.js`：Canvas 实时任务与 Worker 状态可视化。
- `src/performance-monitor.js`：PerformanceObserver long task 监控。
- `src/app.js`：页面交互和最终一致性校验。
