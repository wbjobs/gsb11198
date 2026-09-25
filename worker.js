'use strict';

// 纯计算函数：主线程降级时使用完全相同的算法，保证结果一致
function computeRange(start, end) {
  let acc = 0;
  for (let i = start; i <= end; i++) {
    acc = (acc + (i * i) % 997) % 1000000007;
  }
  return acc;
}

self.onmessage = (e) => {
  const msg = e.data;

  if (msg.type === 'run') {
    const result = computeRange(msg.start, msg.end);
    const opts = msg.chaos || {};

    // 模拟消息丢失：直接不回消息（由主线程超时兜底）
    if (opts.drop && Math.random() < 0.5) {
      return;
    }

    const post = () => self.postMessage({ id: msg.id, result });

    // 模拟消息乱序：随机延迟回复，多 Worker 下结果顺序与提交顺序不同
    if (opts.reorder) {
      setTimeout(post, Math.random() * 1500);
    } else {
      post();
    }
  } else if (msg.type === 'hang') {
    // 模拟死循环/卡死 —— 主线程超时后会 terminate 该 Worker
    while (true) {}
  } else if (msg.type === 'oom') {
    // 模拟内存溢出：持续分配直到被浏览器杀掉（失败也会被超时兜底）
    const blobs = [];
    while (true) {
      blobs.push(new Array(1000000).fill(Math.random()));
    }
  }
};
