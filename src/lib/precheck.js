// 盈利预检纯数学（不碰网络，node --test 直接覆盖）。
// 合约 withgas 只保证 helper「不亏」（按 initialize 固化的虚拟单价），
// 要「有赚」得链下自己算：奖励份额按当时行情折算 native，对照真实 gas 成本。
// L1 偏移链（Base 等）的 L1 data fee 分量计入 gasPrice 口径后此公式不变——README 盈利模型。
export function evaluateProfit({ expectedNative, gasUnits, gasPrice, bufferX10 = 12n }) {
  const expected = BigInt(expectedNative);
  const gasCost = BigInt(gasUnits) * BigInt(gasPrice);
  // ×1.2 = ×12/10，向上取整（宁可错杀）
  const threshold = (gasCost * BigInt(bufferX10) + 9n) / 10n;
  return {
    ok: expected >= threshold,
    expected,
    gasCost,
    threshold,
    margin: expected - gasCost,
  };
}

// minNativeOut：行情折算 × bps/10000（默认 95%），防三明治吃穿换币；
// 极端行情下即使被打穿，合约 withgas 约束仍整笔 revert 兜底 helper 不亏
export function minOutFromQuote(quote, minOutBps = 9500n) {
  return (BigInt(quote) * BigInt(minOutBps)) / 10000n;
}
