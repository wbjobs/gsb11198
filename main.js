'use strict';

/* ================= 配置 ================= */
const CONFIG = {
  poolSize: 4,
  taskTimeout: 3000,
  maxRetries: 2,
  chunkSize: 2000000,
  defaultTaskCount: 12,
  defaultTaskSize: 5000000,
};

/* ================= 混沌注入开关 ================= */
const chaos = {
  noWorker: false,
  createFail: false,
  dropMessage: false,
  reorder: false,
  randomCrash: false,
  oom: false,
};

/* ================= 计算逻辑(与 worker.js 完全一致) ================= */
function computeRange(start, end) {
  let acc = 0;
  for (let i = start; i <= end; i++) {
    acc = (acc + (i * i) % 997) % 1000000007;
  }
  return acc;
}

function yieldToMain() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// 主线程降级执行：分块 + 让出主线程，保证 UI 不卡死
async function computeRangeAsync(start, end, chunkSize) {
  let acc = 0;
  let n = 0;
  for (let i = start; i <= end; i++) {
    acc = (acc + (i * i) % 997) % 1000000007;
    if (++n % chunkSize === 0) {
      performance.mark('fallback-yield');
      await yieldToMain();
    }
  }
  return acc;
}

/* ================= 日志 / 统计 ================= */
const logEl = document.getElementById('log');
const perfEl = document.getElementById('perf');

function log(msg) {
  const line = document.createElement('div');
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  line.textContent = `[${t}] ${msg}`;
  logEl.prepend(line);
  while (logEl.children.length > 100) logEl.lastChild.remove();
}

function perfLog(msg) {
  const line = document.createElement('div');
  line.textContent = msg;
  perfEl.prepend(line);
  while (perfEl.children.length > 30) perfEl.lastChild.remove();
}

/* ================= Worker 槽位 ================= */
class WorkerSlot {
  constructor(manager, id) {
    this.manager = manager;
    this.id = id;
    this.worker = null;
    this.task = null;
    this.timer = null;
    this.state = 'dead';
    this.spawn();
  }

  spawn() {
    if (chaos.noWorker || typeof Worker === 'undefined') {
      this.state = 'dead';
      log(`Slot#${this.id}: 浏览器不支持 Worker，保持死亡状态`);
      return false;
    }
    try {
      if (chaos.createFail) throw new Error('模拟创建失败(URL/资源错误)');
      this.worker = new Worker('worker.js');
    } catch (err) {
      this.worker = null;
      this.state = 'dead';
      log(`Slot#${this.id}: Worker 创建失败 -> ${err.message}`);
      return false;
    }
    this.worker.onmessage = (e) => this.onMessage(e);
    this.worker.onerror = (e) => {
      if (e.preventDefault) e.preventDefault();
      this.kill('worker-error');
    };
    this.state = 'idle';
    log(`Slot#${this.id}: Worker 创建成功`);
    return true;
  }

  assign(task) {
    this.task = task;
    this.state = 'busy';
    task.status = 'running';
    task.attempts += 1;
    task.assignedSlot = this.id;

    // 随机崩溃 / 随机 OOM 注入
    if (chaos.randomCrash && Math.random() < 0.35) {
      setTimeout(() => {
        if (this.task === task) this.kill('随机崩溃');
      }, 150 + Math.random() * 600);
    }
    if (chaos.oom && Math.random() < 0.3) {
      this.worker.postMessage({ type: 'oom' });
    }

    this.worker.postMessage({
      type: 'run',
      id: task.id,
      start: task.start,
      end: task.end,
      chaos: { drop: chaos.dropMessage, reorder: chaos.reorder },
    });

    this.timer = setTimeout(() => this.onTimeout(), CONFIG.taskTimeout);
  }

  onMessage(e) {
    const { id, result } = e.data;
    // 只认当前任务：超时重发后姗姗来迟的旧消息 / 乱序消息不会串任务
    if (!this.task || this.task.id !== id) {
      log(`Slot#${this.id}: 收到过期/乱序消息 task#${id}，安全忽略`);
      return;
    }
    clearTimeout(this.timer);
    this.timer = null;
    const task = this.task;
    this.task = null;
    this.state = 'idle';
    log(`Slot#${this.id}: task#${task.id} 完成`);
    this.manager.complete(task, result, 'worker');
    this.manager.pump();
  }

  onTimeout() {
    log(`Slot#${this.id}: task#${this.task ? this.task.id : '?'} 执行超时(${CONFIG.taskTimeout}ms)`);
    this.manager.stats.timeouts += 1;
    this.kill('timeout');
  }

  hang() {
    if (this.worker) this.worker.postMessage({ type: 'hang' });
  }

  requestOom() {
    if (this.worker) this.worker.postMessage({ type: 'oom' });
  }

  kill(reason) {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.worker) {
      this.worker.terminate(); // 主线程强制终止
      this.worker = null;
    }
    this.state = 'dead';
    this.manager.stats.crashes += 1;
    const task = this.task;
    this.task = null;
    log(`Slot#${this.id}: Worker 被终止(${reason})`);
    if (task) this.manager.requeue(task, reason);
    // 尝试重建；重建失败则由 pump 把队列降级到主线程
    setTimeout(() => {
      this.spawn();
      this.manager.pump();
    }, 120);
  }
}

/* ================= 任务管理器：分发 / 重试 / 降级 ================= */
const manager = {
  slots: [],
  queue: [],
  tasks: new Map(),
  taskList: [],
  events: [],
  nextTaskId: 1,
  nextSeq: 0,
  stats: {
    submitted: 0,
    doneWorker: 0,
    doneFallback: 0,
    retried: 0,
    timeouts: 0,
    crashes: 0,
    fallbacks: 0,
  },

  init() {
    for (let i = 0; i < CONFIG.poolSize; i += 1) {
      this.slots.push(new WorkerSlot(this, i));
    }
  },

  anyWorkerAlive() {
    if (chaos.noWorker || typeof Worker === 'undefined') return false;
    return this.slots.some((s) => s.state !== 'dead');
  },

  submitBatch(count, size) {
    for (let i = 0; i < count; i += 1) {
      const id = this.nextTaskId;
      this.nextTaskId += 1;
      const task = {
        id,
        seq: this.nextSeq++,
        start: (id - 1) * size + 1,
        end: id * size,
        status: 'pending',
        attempts: 0,
        retries: 0,
        result: null,
        assignedSlot: -1,
        done: false,
      };
      this.tasks.set(id, task);
      this.taskList.push(task);
      this.queue.push(task);
      this.stats.submitted += 1;
      this.pushEvent('submit');
    }
    log(`提交 ${count} 个任务(每个 ${size.toLocaleString()} 次迭代)`);
    this.pump();
  },

  pump() {
    // 没有任何可用 Worker(不支持/创建失败/全部死亡) -> 全量降级
    if (!this.anyWorkerAlive()) {
      log('没有可用 Worker，队列整体降级到主线程分块执行');
      while (this.queue.length > 0) {
        this.runFallback(this.queue.shift(), 'no-worker');
      }
      return;
    }
    for (const slot of this.slots) {
      if (this.queue.length === 0) break;
      if (slot.state === 'idle') slot.assign(this.queue.shift());
    }
  },

  requeue(task, reason) {
    if (task.done) return;
    task.retries += 1;
    this.stats.retried += 1;
    this.pushEvent('retry');
    if (task.retries > CONFIG.maxRetries || !this.anyWorkerAlive()) {
      log(`task#${task.id}: 重试已达上限或 Worker 不可用 -> 降级(${reason})`);
      this.runFallback(task, reason);
    } else {
      log(`task#${task.id}: 重新入队(${reason}, 第 ${task.retries} 次重试)`);
      task.status = 'pending';
      this.queue.unshift(task);
      this.pump();
    }
  },

  async runFallback(task, reason) {
    if (task.done) return;
    task.status = 'fallback';
    this.stats.fallbacks += 1;
    this.pushEvent('fallback');
    log(`task#${task.id}: 主线程降级执行开始(${reason})`);
    const markName = `fallback-task-${task.id}`;
    performance.mark(`${markName}-start`);
    try {
      const result = await computeRangeAsync(task.start, task.end, CONFIG.chunkSize);
      performance.mark(`${markName}-end`);
      performance.measure(markName, `${markName}-start`, `${markName}-end`);
      this.complete(task, result, 'fallback');
    } catch (err) {
      log(`task#${task.id}: 降级执行异常 -> ${err.message}`);
      task.done = true;
      task.status = 'failed';
    }
    this.pump();
  },

  complete(task, result, source) {
    if (task.done) return;
    task.done = true;
    task.result = result;
    task.status = source === 'worker' ? 'done-worker' : 'done-fallback';
    if (source === 'worker') {
      this.stats.doneWorker += 1;
    } else {
      this.stats.doneFallback += 1;
    }
    this.pushEvent(source === 'worker' ? 'done' : 'done-fallback');
    log(
      `task#${task.id} 完成 [${source === 'worker' ? 'Worker' : '降级'}] result=${result}`
    );
    if (document.getElementById('verify').checked) this.verify(task);
  },

  async verify(task) {
    // 用主线程同算法异步重算一次，验证 Worker/降级结果一致性
    const expected = await computeRangeAsync(task.start, task.end, CONFIG.chunkSize);
    if (expected === task.result) {
      log(`task#${task.id}: 校验通过 ✓ (result=${task.result})`);
    } else {
      log(`task#${task.id}: 校验不一致 ✗ expected=${expected} got=${task.result}`);
    }
  },

  pushEvent(type) {
    this.events.push({ type, t: performance.now() });
    if (this.events.length > 120) this.events.shift();
  },

  reviveAll() {
    this.slots.forEach((s) => {
      if (s.state === 'dead') s.spawn();
    });
    this.pump();
  },
};

/* ================= Canvas 状态可视化 ================= */
const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');

const COLORS = {
  idle: '#2ecc71',
  busy: '#3498db',
  dead: '#e74c3c',
  pending: '#95a5a6',
  running: '#3498db',
  fallback: '#e67e22',
  'done-worker': '#27ae60',
  'done-fallback': '#e67e22',
  failed: '#c0392b',
  submit: '#95a5a6',
  retry: '#9b59b6',
  done: '#27ae60',
  'done-fallback-ev': '#e67e22',
};

let fps = 0;
let fpsAccum = 0;
let fpsFrames = 0;

function draw() {
  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = '#1e2430';
  ctx.fillRect(0, 0, W, H);

  // ---- Worker 槽位 ----
  ctx.font = '13px monospace';
  ctx.fillStyle = '#ecf0f1';
  ctx.fillText('Workers', 12, 18);

  const slotW = 120;
  const slotH = 46;
  manager.slots.forEach((slot, i) => {
    const x = 12 + i * (slotW + 10);
    const y = 28;
    ctx.fillStyle = COLORS[slot.state] || '#7f8c8d';
    ctx.fillRect(x, y, slotW, slotH);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 13px monospace';
    ctx.fillText(`W${slot.id} ${slot.state.toUpperCase()}`, x + 8, y + 19);
    ctx.font = '11px monospace';
    ctx.fillText(
      slot.task ? `task#${slot.task.id}` : '空闲',
      x + 8,
      y + 36
    );
  });

  // ---- 统计 ----
  const s = manager.stats;
  ctx.fillStyle = '#ecf0f1';
  ctx.font = '12px monospace';
  const statText =
    `队列:${manager.queue.length}  已提交:${s.submitted}  ` +
    `Worker完成:${s.doneWorker}  降级完成:${s.doneFallback}  ` +
    `超时:${s.timeouts}  崩溃:${s.crashes}  重试:${s.retried}  FPS:${fps}`;
  ctx.fillText(statText, 12, 98);

  // ---- 任务网格 ----
  ctx.fillText('任务状态 (按提交顺序)', 12, 120);
  const cell = 10;
  const gap = 2;
  const cols = Math.floor((W - 24) / (cell + gap));
  manager.taskList.forEach((task, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = 12 + col * (cell + gap);
    const y = 128 + row * (cell + gap);
    ctx.fillStyle = COLORS[task.status] || '#7f8c8d';
    ctx.fillRect(x, y, cell, cell);
  });

  // 图例
  const legend = [
    ['pending', '排队'],
    ['running', 'Worker执行'],
    ['done-worker', 'Worker完成'],
    ['fallback', '降级执行'],
    ['done-fallback', '降级完成'],
    ['dead', 'Worker死亡'],
  ];
  let lx = 12;
  const ly = H - 18;
  ctx.font = '11px monospace';
  legend.forEach(([key, label]) => {
    ctx.fillStyle = COLORS[key];
    ctx.fillRect(lx, ly - 9, 10, 10);
    ctx.fillStyle = '#ecf0f1';
    ctx.fillText(label, lx + 14, ly);
    lx += 14 + ctx.measureText(label).width + 14;
  });

  // ---- 底部事件时间线 ----
  const evCount = manager.events.length;
  const evW = 6;
  for (let i = 0; i < evCount; i += 1) {
    const ev = manager.events[evCount - 1 - i];
    const x = W - 12 - (i + 1) * (evW + 1);
    const key = ev.type === 'done-fallback' ? 'done-fallback-ev' : ev.type;
    ctx.fillStyle = COLORS[key] || '#bdc3c7';
    ctx.fillRect(x, H - 52, evW, 26);
  }
  ctx.fillStyle = '#7f8c8d';
  ctx.fillText('事件时间线 (右=最新)', 12, H - 34);
}

let lastFrame = performance.now();
function loop(now) {
  const delta = now - lastFrame;
  lastFrame = now;
  fpsAccum += delta;
  fpsFrames += 1;
  if (fpsAccum >= 500) {
    fps = Math.round(1000 / (fpsAccum / fpsFrames));
    fpsAccum = 0;
    fpsFrames = 0;
    renderStatsDom();
  }
  draw();
  requestAnimationFrame(loop);
}

function renderStatsDom() {
  const s = manager.stats;
  document.getElementById('stats').innerHTML = [
    `已提交任务: <b>${s.submitted}</b>`,
    `Worker 完成: <b style="color:#27ae60">${s.doneWorker}</b>`,
    `降级完成: <b style="color:#e67e22">${s.doneFallback}</b>`,
    `超时次数: <b>${s.timeouts}</b>`,
    `崩溃/终止: <b>${s.crashes}</b>`,
    `重试次数: <b>${s.retried}</b>`,
    `降级触发: <b>${s.fallbacks}</b>`,
  ].join('<br>');
}

/* ================= PerformanceObserver ================= */
function initPerfObserver() {
  if (typeof PerformanceObserver === 'undefined') {
    perfLog('当前浏览器不支持 PerformanceObserver');
    return;
  }
  try {
    const supported = PerformanceObserver.supportedEntryTypes || [];
    const watch = ['longtask', 'measure'].filter((t) => supported.includes(t));
    if (watch.length === 0) {
      perfLog('不支持 longtask / measure 观测类型');
      return;
    }
    const observer = new PerformanceObserver((list) => {
      list.getEntries().forEach((entry) => {
        if (entry.entryType === 'longtask') {
          perfLog(`⚠ LongTask 主线程阻塞 ${entry.duration.toFixed(1)}ms`);
        } else if (entry.entryType === 'measure' && entry.name.startsWith('fallback-')) {
          perfLog(`${entry.name} 耗时 ${entry.duration.toFixed(1)}ms`);
        }
      });
    });
    observer.observe({ entryTypes: watch });
    perfLog(`观测中: ${watch.join(', ')}`);
  } catch (err) {
    perfLog(`PerformanceObserver 初始化失败: ${err.message}`);
  }
}

/* ================= 控件绑定 ================= */
function bindControls() {
  const countInput = document.getElementById('taskCount');
  const sizeInput = document.getElementById('taskSize');
  countInput.value = CONFIG.defaultTaskCount;
  sizeInput.value = CONFIG.defaultTaskSize;

  document.getElementById('submitTasks').addEventListener('click', () => {
    const count = Math.max(1, parseInt(countInput.value, 10) || CONFIG.defaultTaskCount);
    const size = Math.max(1, parseInt(sizeInput.value, 10) || CONFIG.defaultTaskSize);
    manager.submitBatch(count, size);
  });

  Object.keys(chaos).forEach((key) => {
    const cb = document.getElementById(`chaos-${key}`);
    if (cb) {
      cb.addEventListener('change', () => {
        chaos[key] = cb.checked;
        log(`混沌注入 [${key}] = ${cb.checked ? '开' : '关'}`);
      });
    }
  });

  const pickAlive = () => manager.slots.filter((s) => s.state !== 'dead');

  document.getElementById('crashWorker').addEventListener('click', () => {
    const alive = pickAlive();
    if (alive.length === 0) return log('没有存活的 Worker 可崩溃');
    const slot = alive[Math.floor(Math.random() * alive.length)];
    log(`手动让 Slot#${slot.id} 进入死循环(将触发超时)`);
    slot.hang();
  });

  document.getElementById('oomWorker').addEventListener('click', () => {
    const alive = pickAlive();
    if (alive.length === 0) return log('没有存活的 Worker 可注入 OOM');
    const slot = alive[Math.floor(Math.random() * alive.length)];
    log(`手动向 Slot#${slot.id} 注入内存溢出`);
    slot.requestOom();
  });

  document.getElementById('terminateWorker').addEventListener('click', () => {
    const alive = pickAlive();
    if (alive.length === 0) return log('没有存活的 Worker 可终止');
    const slot = alive[Math.floor(Math.random() * alive.length)];
    slot.kill('主线程手动终止');
  });

  document.getElementById('reviveWorkers').addEventListener('click', () => {
    log('尝试恢复所有死亡 Worker');
    manager.reviveAll();
  });
}

/* ================= 启动 ================= */
manager.init();
bindControls();
initPerfObserver();
requestAnimationFrame(loop);
log('演示已启动。先勾选混沌开关，再提交任务观察异常与自动降级。');
