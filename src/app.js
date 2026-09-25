import { Dispatcher } from "./dispatcher.js";
import { Visualizer } from "./visualizer.js";
import { PerformanceMonitor } from "./performance-monitor.js";

const WORKER_COUNT = 3;
const RUN_TIMEOUT_MS = 1500;

const faultCheckboxes = [
  { key: "unsupported", id: "faultUnsupported", label: "Worker 不支持" },
  { key: "createFail", id: "faultCreateFail", label: "Worker 创建失败" },
  { key: "timeout", id: "faultTimeout", label: "执行超时" },
  { key: "lost", id: "faultLost", label: "消息丢失" },
  { key: "order", id: "faultOrder", label: "消息乱序" },
  { key: "crash", id: "faultCrash", label: "Worker 崩溃" },
  { key: "oom", id: "faultOom", label: "内存溢出" },
];

const elementIds = [
  "runButton", "resetButton", "selectAllFaults", "phaseText", "environmentText",
  "workerList", "eventLog", "resultBody", "metricQueued", "metricRunning",
  "metricRetry", "metricFallback", "metricDone", "metricMismatch",
  "consistencyText", "statusCanvas", "performanceCanvas", "longTaskCount", "longTaskMax",
];
const elements = Object.fromEntries(elementIds.map((id) => [id, document.getElementById(id)]));

const visualizer = new Visualizer(elements.statusCanvas);
const performanceMonitor = new PerformanceMonitor(
  elements.performanceCanvas,
  elements.longTaskCount,
  elements.longTaskMax,
);

let runStartedAt = Date.now();
let dispatcher = null;
let currentTasks = buildTasks();

elements.environmentText.textContent = typeof Worker === "undefined"
  ? "当前浏览器没有原生 Worker 能力。"
  : `当前浏览器支持 Web Worker；将创建 ${WORKER_COUNT} 个 Worker。`;

elements.selectAllFaults.addEventListener("click", () => {
  faultCheckboxes.forEach(({ id }) => {
    document.getElementById(id).checked = true;
  });
  currentTasks = buildTasks();
  renderIdleState();
});

elements.resetButton.addEventListener("click", resetDemo);
elements.runButton.addEventListener("click", runDemo);

faultCheckboxes.forEach(({ id }) => {
  document.getElementById(id).addEventListener("change", () => {
    currentTasks = buildTasks();
    renderIdleState();
  });
});

resetDemo();

async function runDemo() {
  setRunning(true);
  currentTasks = buildTasks();
  runStartedAt = Date.now();
  elements.eventLog.replaceChildren();
  elements.phaseText.textContent = "正在初始化任务分发器";

  const settings = getSettings();
  dispatcher = new Dispatcher({
    workerUrl: new URL("./worker.js", import.meta.url).href,
    workerCount: WORKER_COUNT,
    forceUnsupported: settings.unsupported,
    timeoutMs: RUN_TIMEOUT_MS,
    listeners: {
      log: addLog,
      phase: (phase) => { elements.phaseText.textContent = phase; },
      change: renderState,
      complete: handleComplete,
    },
  });

  performanceMonitor.start();
  renderIdleState();
  await dispatcher.start(currentTasks);
}

function resetDemo() {
  dispatcher?.stop();
  setRunning(false);
  performanceMonitor.stop();
  currentTasks = buildTasks();
  runStartedAt = Date.now();
  elements.phaseText.textContent = "点击“开始演示”。";
  elements.consistencyText.textContent = "等待运行。";
  elements.eventLog.replaceChildren();
  addLog({ level: "info", text: "已重置，可以重新选择故障并运行。" });
  renderIdleState();
}

function buildTasks() {
  const settings = getSettings();
  const faultByIndex = {
    1: settings.createFail ? "createFail" : null,
    2: settings.timeout ? "timeout" : null,
    3: settings.lost ? "lost" : null,
    4: settings.order ? "order" : null,
    5: settings.crash ? "crash" : null,
    6: settings.oom ? "oom" : null,
  };

  return Array.from({ length: 10 }, (_, id) => ({
    id,
    input: 7 + id * 13,
    fault: faultByIndex[id] || null,
  }));
}

function getSettings() {
  return Object.fromEntries(
    faultCheckboxes.map(({ key, id }) => [key, id] && [key, document.getElementById(id).checked]),
  );
}

function setRunning(isRunning) {
  elements.runButton.disabled = isRunning;
  elements.selectAllFaults.disabled = isRunning;
  faultCheckboxes.forEach(({ id }) => {
    document.getElementById(id).disabled = isRunning;
  });
}

function renderIdleState() {
  const snapshot = {
    tasks: currentTasks,
    slots: Array.from({ length: WORKER_COUNT }, (_, id) => ({
      id,
      status: "disabled",
      currentTaskId: null,
    })),
    queue: [],
    fallbackQueue: [],
    retryCount: 0,
    fallbackCount: 0,
    completedCount: 0,
  };
  renderState(snapshot);
}

function renderState(snapshot) {
  const mismatchCount = countMismatches(snapshot.tasks);
  const queuedCount = snapshot.tasks.filter((task) => task.status === "queued").length;
  const activeCount = snapshot.tasks
    .filter((task) => task.status === "running" || task.status === "retry").length;

  elements.metricQueued.textContent = String(queuedCount);
  elements.metricRunning.textContent = String(activeCount);
  elements.metricRetry.textContent = String(snapshot.retryCount);
  elements.metricFallback.textContent = String(snapshot.fallbackCount);
  elements.metricDone.textContent = String(snapshot.completedCount);
  elements.metricMismatch.textContent = String(mismatchCount);

  renderWorkers(snapshot.slots);
  renderResults(snapshot.tasks);
  visualizer.render(snapshot, elements.phaseText.textContent);
}

function renderWorkers(slots) {
  elements.workerList.replaceChildren(...slots.map((slot) => {
    const card = document.createElement("div");
    card.className = "worker-card";

    const dot = document.createElement("span");
    dot.className = `worker-dot ${slot.status}`;

    const info = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = `Worker ${slot.id + 1}`;
    const detail = document.createElement("small");
    detail.textContent = statusText(slot.status);
    info.append(title, detail);

    const task = document.createElement("span");
    task.className = "worker-task";
    task.textContent = slot.currentTaskId === null ? "空闲" : `#${slot.currentTaskId + 1}`;

    card.append(dot, info, task);
    return card;
  }));
}

function renderResults(tasks) {
  elements.resultBody.replaceChildren(...tasks.map((task) => {
    const expected = globalThis.WorkerDemo.computeTask(task.input);
    const row = document.createElement("tr");
    const values = [
      `#${task.id + 1}`,
      task.input,
      "",
      routeText(task.route),
      task.arrivalOrder ?? "—",
      task.duration === null ? "—" : `${task.duration} ms`,
      task.value ?? "—",
      task.status === "done" ? (task.value === expected ? "一致" : "不一致") : "等待",
    ];

    values.forEach((value, index) => {
      const cell = document.createElement("td");
      if (index === 2) {
        const badge = document.createElement("span");
        badge.className = `badge ${task.status}`;
        badge.textContent = statusLabel(task.status, task.error);
        cell.append(badge);
      } else if (index === 7) {
        cell.className = task.status === "done"
          ? task.value === expected ? "ok" : "bad"
          : "";
        cell.textContent = value;
      } else {
        cell.textContent = value;
      }
      row.append(cell);
    });

    return row;
  }));
}

function handleComplete(snapshot) {
  const mismatchCount = countMismatches(snapshot.tasks);
  const fallbackCount = snapshot.tasks.filter((task) => task.route === "fallback").length;
  const workerCount = snapshot.tasks.filter((task) => task.route === "worker").length;

  elements.consistencyText.textContent = mismatchCount === 0
    ? `校验通过：Worker 完成 ${workerCount} 个，备用方案完成 ${fallbackCount} 个，${snapshot.tasks.length} 个结果全部一致。`
    : `校验失败：有 ${mismatchCount} 个结果与共享纯函数不一致。`;

  elements.phaseText.textContent = mismatchCount === 0
    ? "演示完成：异常已恢复，结果一致"
    : "演示完成：存在结果不一致";
  addLog({
    level: mismatchCount === 0 ? "success" : "error",
    text: mismatchCount === 0 ? "最终一致性校验通过" : "最终一致性校验失败",
  });
  performanceMonitor.stop();
  visualizer.render(snapshot, elements.phaseText.textContent);
  setRunning(false);
}

function countMismatches(tasks) {
  return tasks.reduce((count, task) => {
    if (task.status !== "done") return count;
    const expected = globalThis.WorkerDemo.computeTask(task.input);
    return count + (task.value === expected ? 0 : 1);
  }, 0);
}

function addLog({ level = "info", text }) {
  const item = document.createElement("li");
  const time = document.createElement("time");
  const elapsed = ((Date.now() - runStartedAt) / 1000).toFixed(1);
  time.textContent = `${elapsed}s`;

  const message = document.createElement("span");
  const marker = document.createElement("strong");
  marker.textContent = `${logPrefix(level)} `;
  message.append(marker, document.createTextNode(text));
  item.append(time, message);
  elements.eventLog.prepend(item);

  while (elements.eventLog.children.length > 28) {
    elements.eventLog.lastElementChild?.remove();
  }
}

function statusText(status) {
  return {
    ready: "就绪",
    busy: "执行任务中",
    dead: "已终止或崩溃",
    disabled: "未创建",
  }[status] || status;
}

function statusLabel(status, error) {
  if (status === "done") return "完成";
  if (status === "fallback") return `降级·${errorLabel(error)}`;
  if (status === "retry") return "等待重试";
  if (status === "running") return "执行中";
  return "等待";
}

function errorLabel(error) {
  return {
    "worker-unsupported": "不支持",
    "worker-create-failed": "创建失败",
    "worker-create-threw": "创建异常",
    timeout: "超时终止",
    "worker-crash": "崩溃",
    "memory-limit": "内存溢出",
    "worker-error": "Worker错误",
  }[error] || "异常";
}

function routeText(route) {
  return route === "worker" ? "Worker" : route === "fallback" ? "主线程备用" : "—";
}

function logPrefix(level) {
  return {
    info: "信息",
    success: "成功",
    warning: "恢复",
    error: "异常",
  }[level] || "信息";
}
