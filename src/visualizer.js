const STATUS_COLORS = {
  queued: "#94a3b8",
  running: "#fbbf24",
  retry: "#a78bfa",
  fallback: "#60a5fa",
  done: "#34d399",
  error: "#fb7185",
};

const STATUS_LABELS = {
  queued: "等待",
  running: "Worker",
  retry: "重试",
  fallback: "降级",
  done: "完成",
  error: "异常",
};

export class Visualizer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.resize();
    window.addEventListener("resize", () => {
      this.resize();
    });
  }

  resize() {
    const ratio = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.height = this.height || 300;
    this.canvas.style.height = `${this.height}px`;
    this.canvas.width = Math.max(1, Math.round(rect.width * ratio));
    this.canvas.height = Math.max(1, Math.round(this.height * ratio));
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.width = rect.width;
  }

  render(snapshot, phase) {
    const ctx = this.ctx;
    const width = this.width || 760;
    const columns = width < 680 ? 3 : 5;
    const rows = Math.ceil((snapshot?.tasks || []).length / columns);
    const height = Math.max(300, 168 + rows * 58 + 34);
    if (height !== this.height) {
      this.height = height;
      this.resize();
    }
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#0a1022";
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = "#e5edf8";
    ctx.font = "700 15px system-ui";
    ctx.fillText(phase, 20, 28);

    const slots = snapshot?.slots || [];
    const slotWidth = Math.min(180, (width - 56 - (slots.length - 1) * 12) / Math.max(1, slots.length));
    slots.forEach((slot, index) => {
      const x = 20 + index * (slotWidth + 12);
      this.drawWorker(x, 48, slotWidth, 64, slot);
    });

    ctx.strokeStyle = "rgba(148, 163, 184, 0.18)";
    ctx.beginPath();
    ctx.moveTo(20, 132);
    ctx.lineTo(width - 20, 132);
    ctx.stroke();

    ctx.fillStyle = "#94a3b8";
    ctx.font = "700 12px system-ui";
    ctx.fillText("任务队列（卡片中的数字为到达顺序，卡片顺序固定为任务 ID）", 20, 154);

    const tasks = snapshot?.tasks || [];
    const gap = 10;
    const cardWidth = (width - 40 - (columns - 1) * gap) / columns;
    tasks.forEach((task, index) => {
      const col = index % columns;
      const row = Math.floor(index / columns);
      const x = 20 + col * (cardWidth + gap);
      const y = 168 + row * 58;
      this.drawTask(x, y, cardWidth, 48, task);
    });

    this.drawLegend(width, height);
  }

  drawWorker(x, y, width, height, slot) {
    const ctx = this.ctx;
    const color = slot.status === "busy"
      ? STATUS_COLORS.running
      : slot.status === "ready"
        ? STATUS_COLORS.done
        : slot.status === "dead"
          ? STATUS_COLORS.error
          : STATUS_COLORS.queued;

    ctx.fillStyle = "rgba(255,255,255,0.045)";
    this.roundRect(x, y, width, height, 14);
    ctx.fill();

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    this.roundRect(x, y, width, height, 14);
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x + 18, y + 22, 6, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#e5edf8";
    ctx.font = "750 13px system-ui";
    ctx.fillText(`Worker ${slot.id + 1}`, x + 32, y + 20);

    ctx.fillStyle = "#94a3b8";
    ctx.font = "11px system-ui";
    const detail = slot.currentTaskId === null
      ? slot.status === "dead" ? "已退出，等待恢复" : "空闲"
      : `处理任务 #${slot.currentTaskId + 1}`;
    ctx.fillText(detail, x + 32, y + 41);
  }

  drawTask(x, y, width, height, task) {
    const ctx = this.ctx;
    const color = STATUS_COLORS[task.status] || STATUS_COLORS.queued;

    ctx.fillStyle = "rgba(255,255,255,0.045)";
    this.roundRect(x, y, width, height, 12);
    ctx.fill();

    ctx.fillStyle = color;
    this.roundRect(x, y, 5, height, 3);
    ctx.fill();

    ctx.fillStyle = "#e5edf8";
    ctx.font = "750 12px system-ui";
    ctx.fillText(`#${task.id + 1}  n=${task.input}`, x + 13, y + 18);

    ctx.fillStyle = "#94a3b8";
    ctx.font = "11px system-ui";
    const result = task.status === "done" ? `结果 ${task.value}` : STATUS_LABELS[task.status] || task.status;
    ctx.fillText(result, x + 13, y + 35);

    if (task.arrivalOrder) {
      ctx.fillStyle = "rgba(56, 189, 248, 0.18)";
      this.roundRect(x + width - 42, y + 11, 31, 22, 9);
      ctx.fill();
      ctx.fillStyle = "#7dd3fc";
      ctx.font = "750 11px system-ui";
      ctx.textAlign = "center";
      ctx.fillText(String(task.arrivalOrder), x + width - 26.5, y + 26);
      ctx.textAlign = "left";
    }
  }

  drawLegend(width, height) {
    const ctx = this.ctx;
    const items = [
      ["等待", STATUS_COLORS.queued],
      ["执行", STATUS_COLORS.running],
      ["重试", STATUS_COLORS.retry],
      ["降级", STATUS_COLORS.fallback],
      ["完成", STATUS_COLORS.done],
    ];
    let x = 20;
    items.forEach(([label, color]) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, height - 18, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#94a3b8";
      ctx.font = "11px system-ui";
      ctx.fillText(label, x + 9, height - 14);
      x += 66;
    });
  }

  roundRect(x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
  }
}
