(function attachCompute(global) {
  function computeTask(input) {
    const n = Number(input);
    if (!Number.isInteger(n) || n < 0 || n > 9999) {
      throw new RangeError("输入必须是 0 到 9999 的整数");
    }
    return (((n * 7 + 13) % 97) * n);
  }

  global.WorkerDemo = global.WorkerDemo || {};
  global.WorkerDemo.computeTask = computeTask;
})(typeof self !== "undefined" ? self : this);
