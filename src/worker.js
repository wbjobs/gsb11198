"use strict";

importScripts("./compute.js");

const BASE_DURATION = 130;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function simulateMemoryPressure() {
  const error = new RangeError("模拟内存溢出：Worker 无法继续分配缓冲区");
  error.simulatedMemoryLimit = true;
  throw error;
}

async function runTask(task) {
  const { id, input, fault, attempt } = task;
  const startedAt = performance.now();

  if (fault === "timeout" && attempt === 0) {
    await wait(60_000);
  }

  if (fault === "lost" && attempt === 0) {
    await wait(160);
    return;
  }

  if (fault === "crash" && attempt === 0) {
    await wait(150);
    throw new Error(`Worker 在任务 #${id} 第一次尝试时崩溃`);
  }

  if (fault === "oom" && attempt === 0) {
    await wait(90);
    try {
      simulateMemoryPressure();
    } catch (error) {
      self.postMessage({
        type: "error",
        id,
        attempt,
        errorType: "memory",
        message: error.message,
      });
      return;
    }
  }

  let duration = BASE_DURATION + id * 28;
  if (fault === "order" && attempt === 0) {
    duration = 950;
  }

  await wait(duration);
  const value = self.WorkerDemo.computeTask(input);
  self.postMessage({
    type: "result",
    id,
    attempt,
    value,
    duration: Math.round(performance.now() - startedAt),
  });
}

self.onmessage = (event) => {
  const message = event.data;
  if (message.type !== "run") return;

  runTask(message.task).catch((error) => {
    setTimeout(() => {
      throw error;
    }, 0);
  });
};
