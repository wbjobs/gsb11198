const MAX_ATTEMPTS = 2;
const TASK_TIMEOUT_MS = 1500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Dispatcher {
  constructor({ workerUrl, workerCount = 3, forceUnsupported = false, timeoutMs = TASK_TIMEOUT_MS, listeners = {} }) {
    this.workerUrl = workerUrl;
    this.workerCount = workerCount;
    this.forceUnsupported = forceUnsupported;
    this.timeoutMs = timeoutMs;
    this.listeners = listeners;
    this.tasks = [];
    this.queue = [];
    this.fallbackQueue = [];
    this.fallbackRunning = false;
    this.running = false;
    this.arrivalCount = 0;
    this.retryCount = 0;
    this.fallbackCount = 0;
    this.completedCount = 0;
    this.runToken = 0;
    this.slots = Array.from({ length: workerCount }, (_, index) => ({
      id: index,
      worker: null,
      status: "disabled",
      currentTaskId: null,
      timeoutId: null,
      generation: 0,
    }));
  }

  async start(tasks) {
    this.reset();
    this.tasks = tasks.map((task) => ({
      duration: null,
      error: null,
      route: null,
      startedAt: null,
      finishedAt: null,
      attempts: 0,
      arrivalOrder: null,
      workerId: null,
      ...task,
      status: "queued",
    }));
    this.running = true;
    this.emit("phase", "正在分发任务");

    if (this.forceUnsupported || typeof Worker === "undefined") {
      this.emit("log", { level: "error", text: "当前环境不支持 Web Worker，全部任务进入备用方案" });
      this.slots.forEach((slot) => {
        slot.status = "disabled";
      });
      this.tasks.forEach((task) => this.enqueueFallback(task.id, "worker-unsupported"));
      this.pumpFallback();
      this.emitChange();
      return;
    }

    this.queue = this.tasks.map((task) => task.id);
    this.pump();
  }

  reset() {
    this.runToken += 1;
    this.running = false;
    this.slots.forEach((slot) => this.cleanupSlot(slot));
    this.tasks = [];
    this.queue = [];
    this.fallbackQueue = [];
    this.fallbackRunning = false;
    this.running = false;
    this.arrivalCount = 0;
    this.retryCount = 0;
    this.fallbackCount = 0;
    this.completedCount = 0;
  }

  pump() {
    if (!this.running) return;

    while (this.queue.length > 0) {
      const taskId = this.queue[0];
      const task = this.getTask(taskId);
      if (!task || task.status === "done") {
        this.queue.shift();
        continue;
      }

      const slot = this.slots.find((item) => item.status === "ready" || item.status === "disabled");
      if (!slot) break;

      this.queue.shift();
      this.dispatchToWorker(slot, task);
    }

    this.pumpFallback();
    this.emitChange();
  }

  dispatchToWorker(slot, task) {
    try {
      if (!slot.worker) {
        slot.status = "disabled";
        this.emit("log", { level: "info", text: `正在创建 Worker ${slot.id + 1}` });
        slot.worker = this.createWorker(slot, task);
        slot.status = "ready";
      }

      task.attempts += 1;
      task.status = task.attempts > 1 ? "retry" : "running";
      task.route = "worker";
      task.workerId = slot.id;
      task.startedAt = performance.now();
      task.error = null;
      slot.status = "busy";
      slot.currentTaskId = task.id;
      slot.timeoutId = setTimeout(() => {
        this.handleTimeout(slot, task);
      }, this.timeoutMs);

      slot.worker.postMessage({
        type: "run",
        task: {
          id: task.id,
          input: task.input,
          fault: task.fault,
          attempt: task.attempts - 1,
        },
      });

      this.emit("log", {
        level: task.attempts > 1 ? "warning" : "info",
        text: `任务 #${task.id + 1} 第 ${task.attempts} 次发送到 Worker ${slot.id + 1}`,
      });
      this.emitChange();
    } catch (error) {
      this.cleanupSlot(slot);
      slot.status = "dead";
      this.emit("log", { level: "error", text: `Worker 创建失败：${error.message}` });
      this.enqueueFallback(task.id, "worker-create-threw");
      this.replaceSlot(slot);
      this.pump();
    }
  }

  createWorker(slot, task) {
    if (task?.fault === "createFail") {
      throw new Error("模拟 Worker 构造失败");
    }
    const worker = new Worker(this.workerUrl);
    worker.onmessage = (event) => this.handleWorkerMessage(slot, event.data);
    worker.onerror = (event) => {
      event.preventDefault?.();
      this.handleWorkerCrash(slot, event.message || "Worker 触发未捕获错误");
    };
    return worker;
  }

  handleWorkerMessage(slot, message) {
    const task = this.getTask(message.id);
    if (!task || slot.currentTaskId !== task.id || task.attempts !== message.attempt + 1 || task.status === "done") {
      this.emit("log", { level: "warning", text: "收到过期 Worker 消息，已安全忽略" });
      return;
    }

    clearTimeout(slot.timeoutId);

    if (message.type === "result") {
      slot.currentTaskId = null;
      slot.status = "ready";
      this.completeTask(task, message.value, "worker", slot.id, message.duration);
      this.emit("log", { level: "success", text: `任务 #${task.id + 1} 返回结果 ${message.value}` });
      this.pump();
      return;
    }

    if (message.type === "error") {
      slot.currentTaskId = null;
      slot.status = "ready";
      this.emit("log", { level: "error", text: `任务 #${task.id + 1} 的 Worker 报告：${message.message}` });
      this.handleRecoverableFailure(task, message.errorType === "memory" ? "memory-limit" : "worker-error", slot);
    }
  }

  handleTimeout(slot, task) {
    if (slot.currentTaskId !== task.id || task.status === "done") return;
    this.emit("log", { level: "error", text: `任务 #${task.id + 1} 超过 ${this.timeoutMs}ms，主线程终止 Worker ${slot.id + 1}` });
    this.cleanupSlot(slot, { clearTimer: false });
    slot.status = "dead";
    this.handleRecoverableFailure(task, "timeout", slot);
  }

  handleWorkerCrash(slot, message) {
    const taskId = slot.currentTaskId;
    const task = this.getTask(taskId);
    this.emit("log", { level: "error", text: `Worker ${slot.id + 1} 崩溃${task ? `，任务 #${task.id + 1} 中断` : ""}：${message}` });
    this.cleanupSlot(slot);
    slot.status = "dead";
    if (task && task.status !== "done") {
      this.handleRecoverableFailure(task, "worker-crash", slot);
      return;
    }
    this.replaceSlot(slot);
    this.pump();
  }

  handleRecoverableFailure(task, reason, slot) {
    if (task.attempts < MAX_ATTEMPTS) {
      task.status = "retry";
      task.route = "worker";
      task.error = reason;
      this.retryCount += 1;
      this.queue.unshift(task.id);
      this.emit("log", { level: "warning", text: `任务 #${task.id + 1} 将进行第 ${task.attempts + 1} 次尝试` });
      if (slot && slot.status === "dead") this.replaceSlot(slot);
      this.pump();
      return;
    }

    const shouldReplaceSlot = slot?.status === "dead";
    if (slot && (slot.status === "busy" || slot.status === "ready")) {
      slot.currentTaskId = null;
      slot.status = "ready";
    }
    this.enqueueFallback(task.id, reason);
    if (shouldReplaceSlot) this.replaceSlot(slot);
    this.pump();
  }

  replaceSlot(deadSlot) {
    const generation = deadSlot.generation + 1;
    deadSlot.generation = generation;
    setTimeout(() => {
      if (deadSlot.generation !== generation || deadSlot.worker || !this.running) return;
      try {
        deadSlot.worker = this.createWorker(deadSlot);
        deadSlot.status = "ready";
        this.emit("log", { level: "success", text: `Worker ${deadSlot.id + 1} 已恢复` });
        this.pump();
      } catch (error) {
        deadSlot.status = "dead";
        this.emit("log", { level: "error", text: `Worker ${deadSlot.id + 1} 恢复失败：${error.message}` });
      }
    }, 350);
  }

  enqueueFallback(taskId, reason) {
    const task = this.getTask(taskId);
    if (!task || task.status === "done" || this.fallbackQueue.includes(taskId)) return;
    task.status = "fallback";
    task.route = "fallback";
    task.workerId = null;
    task.error = reason;
    task.startedAt = task.startedAt || performance.now();
    this.fallbackCount += 1;
    this.fallbackQueue.push(taskId);
    this.emit("log", { level: "warning", text: `任务 #${task.id + 1} 切换到主线程备用方案（${reason}）` });
  }

  async pumpFallback() {
    if (this.fallbackRunning || this.fallbackQueue.length === 0) return;
    this.fallbackRunning = true;
    const runToken = this.runToken;

    while (this.fallbackQueue.length > 0) {
      const taskId = this.fallbackQueue.shift();
      const task = this.getTask(taskId);
      if (!task || task.status === "done") continue;

      task.status = "fallback";
      this.emitChange();
      await sleep(28);
      if (runToken !== this.runToken) return;

      const startedAt = task.startedAt || performance.now();
      const value = globalThis.WorkerDemo.computeTask(task.input);
      this.completeTask(task, value, "fallback", null, Math.round(performance.now() - startedAt));
      this.emit("log", { level: "success", text: `任务 #${task.id + 1} 备用方案完成，结果 ${value}` });
      this.emitChange();
      this.pump();
      await sleep(0);
      if (runToken !== this.runToken) return;
    }

    this.fallbackRunning = false;
    this.checkComplete();
  }

  completeTask(task, value, route, workerId, duration) {
    this.arrivalCount += 1;
    this.completedCount += 1;
    task.status = "done";
    task.route = route;
    task.workerId = workerId;
    task.value = value;
    task.duration = duration;
    task.arrivalOrder = this.arrivalCount;
    task.finishedAt = performance.now();
  }

  checkComplete() {
    if (!this.running || this.completedCount !== this.tasks.length) return;
    if (this.queue.length || this.fallbackQueue.length || this.slots.some((slot) => slot.currentTaskId !== null)) return;
    this.running = false;
    this.emit("phase", "全部任务完成，正在校验结果一致性");
    this.emit("complete", this.snapshot());
  }

  cleanupSlot(slot, { clearTimer = true } = {}) {
    if (clearTimer) clearTimeout(slot.timeoutId);
    slot.timeoutId = null;
    slot.currentTaskId = null;
    if (slot.worker) {
      slot.worker.onmessage = null;
      slot.worker.onerror = null;
      slot.worker.terminate();
      slot.worker = null;
    }
  }

  stop() {
    this.runToken += 1;
    this.running = false;
    this.queue = [];
    this.fallbackQueue = [];
    this.slots.forEach((slot) => this.cleanupSlot(slot));
  }

  getTask(id) {
    return this.tasks.find((task) => task.id === id);
  }

  emit(type, payload) {
    this.listeners[type]?.(payload);
  }

  emitChange() {
    this.emit("change", this.snapshot());
    this.checkComplete();
  }

  snapshot() {
    return {
      tasks: this.tasks,
      slots: this.slots,
      queue: this.queue,
      fallbackQueue: this.fallbackQueue,
      running: this.running,
      arrivalCount: this.arrivalCount,
      retryCount: this.retryCount,
      fallbackCount: this.fallbackCount,
      completedCount: this.completedCount,
    };
  }
}
