export class PerformanceMonitor {
  constructor(canvas, countElement, maxElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.countElement = countElement;
    this.maxElement = maxElement;
    this.entries = [];
    this.observer = null;
    this.supported = typeof PerformanceObserver !== "undefined";
    this.resize();
    window.addEventListener("resize", () => {
      this.resize();
      this.draw();
    });
  }

  start() {
    this.entries = [];
    this.updateText();
    this.draw();
    if (!this.supported) return;

    this.observer?.disconnect();
    this.observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        this.entries.push({
          startTime: entry.startTime,
          duration: entry.duration,
          name: entry.name,
        });
      }
      if (this.entries.length > 80) {
        this.entries.splice(0, this.entries.length - 80);
      }
      this.updateText();
      this.draw();
    });

    try {
      this.observer.observe({ entryTypes: ["longtask"] });
    } catch {
      this.observer.observe({ type: "longtask", buffered: true });
    }
  }

  stop() {
    this.observer?.disconnect();
  }

  resize() {
    const ratio = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * ratio));
    this.canvas.height = Math.max(1, Math.round(120 * ratio));
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.width = rect.width;
  }

  updateText() {
    this.countElement.textContent = String(this.entries.length);
    const max = this.entries.reduce((acc, entry) => Math.max(acc, entry.duration), 0);
    this.maxElement.textContent = max.toFixed(1);
  }

  draw() {
    const ctx = this.ctx;
    const width = this.width || this.canvas.clientWidth || 360;
    const height = 120;
    ctx.clearRect(0, 0, width, height);

    ctx.fillStyle = "#0a1022";
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = "rgba(148, 163, 184, 0.16)";
    ctx.lineWidth = 1;
    for (let y = 24; y < height; y += 28) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    if (!this.supported) {
      ctx.fillStyle = "#94a3b8";
      ctx.font = "13px system-ui";
      ctx.fillText("当前浏览器不支持 PerformanceObserver longtask", 16, 62);
      return;
    }

    if (this.entries.length === 0) {
      ctx.fillStyle = "#94a3b8";
      ctx.font = "13px system-ui";
      ctx.fillText("暂无 long task；分片降级应保持该区域为空", 16, 62);
      return;
    }

    const first = this.entries[0].startTime;
    const last = Math.max(performance.now(), this.entries[this.entries.length - 1].startTime + 100);
    const range = Math.max(500, last - first);
    const barHeight = 26;

    this.entries.forEach((entry, index) => {
      const x = ((entry.startTime - first) / range) * (width - 28) + 14;
      const barWidth = Math.max(3, (entry.duration / range) * (width - 28));
      const y = 24 + (index % 2) * 42;
      const severity = entry.duration > 100 ? "#fb7185" : entry.duration > 50 ? "#fbbf24" : "#38bdf8";
      ctx.fillStyle = severity;
      ctx.fillRect(x, y, Math.min(barWidth, width - x - 8), barHeight);
      ctx.fillStyle = "#e5edf8";
      ctx.font = "11px system-ui";
      ctx.fillText(`${entry.duration.toFixed(1)}ms`, x + 4, y + 17);
    });
  }
}
