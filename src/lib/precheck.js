// 盈利预检纯数学（不碰网络，node --test 直接覆盖）。
// 合约 withgas 只保证 helper「不亏」（按 initialize 固化的虚拟单价），
// 要「有赚」得链下自己算：奖励份额按当时行情折算 native，对照真实 gas 成本。
// L1 偏移链（Base 等）的 L1 data fee 分量计入 gasPrice 口径后此公式不变——README 盈利模型。
// 公式已收编 @stapleport/worker-kit（与 Executor/SelfSweep 三仓归一）；本仓薄适配保
// gasPrice 参数名，并补收编 Executor 的「零奖励拒绝」语义（expected=0 不出手）。
import { evaluateProfit as kitEvaluateProfit } from '@stapleport/worker-kit';

export function evaluateProfit({ expectedNative, gasUnits, gasPrice, bufferX10 = 12n }) {
  return kitEvaluateProfit({ expectedNative, gasUnits, gasPriceWei: gasPrice, bufferX10 });
}

// minNativeOut：行情折算 × bps/10000（默认 95%），防三明治吃穿换币；
// 极端行情下即使被打穿，合约 withgas 约束仍整笔 revert 兜底 helper 不亏
export { minOutFromQuote } from '@stapleport/worker-kit';

// 广播 gas 上限口径：预估值 ×1.2（防 OOG 裸回滚；预检/盈利口径仍用预估值原值）。
// 2026-09-15 收编自 @stapleport/worker-kit precheck.gasWithHeadroom（Bridge/HelperWorker 同款
// (gas×120)/100）。本仓的估 gas/eth_call 模拟走 viem（execute.js simulateContract /
// estimateContractGas，失败抛 SettleError 不回落——合约必 revert 的单不该用 defaultGas
// 硬发），与 Kit gasPrecheck 的裸 RPC 口径各按所需注入形态取用。
export { gasWithHeadroom } from '@stapleport/worker-kit';
