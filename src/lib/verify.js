// 意图校验 + EIP-712 验签。与付端 dapp 的 src/core/imputepay.js 同口径，
// 规格唯一来源：总库 plans/pay-m1-spec.md（schema v2 七字段）。
import { isAddress, verifyTypedData, hashTypedData, recoverTypedDataAddress } from 'viem';

export const INTENT_TYPES = {
  Intent: [
    { name: 'payee', type: 'address' },
    { name: 'payeeAmount', type: 'uint256' },
    { name: 'token', type: 'address' },
    { name: 'maxHelperReward', type: 'uint256' },
    { name: 'chainId', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

// 与合约 EIP712Upgradeable("ImputePay","1") 逐字一致；chainId 双保险（域名含 + execute 首行核对）
export const imputePayDomain = (chainId, verifyingContract) => ({
  name: 'ImputePay',
  version: '1',
  chainId,
  verifyingContract,
});

// JSON 传输里 uint 以字符串/数字到达 —— 收敛成 bigint 并做形状校验。
// 返回 { intent } 或 { error }；chainId 传入时额外核对跨链错配
export function normalizeIntent(raw, { chainId } = {}) {
  if (!raw || typeof raw !== 'object') return { error: 'intent 必须是对象' };
  const uint = (k) => {
    try {
      const v = BigInt(raw[k]);
      return v >= 0n ? v : null;
    } catch {
      return null;
    }
  };
  const fields = {
    payeeAmount: uint('payeeAmount'),
    maxHelperReward: uint('maxHelperReward'),
    chainId: uint('chainId'),
    nonce: uint('nonce'),
    deadline: uint('deadline'),
  };
  for (const [k, v] of Object.entries(fields)) {
    if (v === null) return { error: `intent.${k} 不是非负整数` };
  }
  if (!isAddress(raw.payee) || !isAddress(raw.token)) {
    return { error: 'intent.payee / intent.token 地址非法' };
  }
  if (fields.payeeAmount === 0n) return { error: 'payeeAmount 必须大于 0' };
  // 合约 execute 首行即 revert（maxHelperReward 禁 0），端口层提前拦
  if (fields.maxHelperReward === 0n) return { error: 'maxHelperReward 禁止 0' };
  const intent = {
    payee: raw.payee,
    payeeAmount: fields.payeeAmount,
    token: raw.token,
    maxHelperReward: fields.maxHelperReward,
    chainId: fields.chainId,
    nonce: fields.nonce,
    deadline: fields.deadline,
  };
  if (chainId != null && intent.chainId !== BigInt(chainId)) {
    return { error: `chainId 错配：意图签的是 ${intent.chainId}，请求目标是 ${chainId}` };
  }
  return { intent };
}

export const intentMessage = (intent) => ({
  payee: intent.payee,
  payeeAmount: intent.payeeAmount,
  token: intent.token,
  maxHelperReward: intent.maxHelperReward,
  chainId: intent.chainId,
  nonce: intent.nonce,
  deadline: intent.deadline,
});

// 验签并恢复付方地址：签名不对/消息被改时抛异常（viem 对错配恢复出别的地址，
// 所以「恢复地址 ≠ 意图内声明付方」的判定在调用侧做——意图里没有 payer 字段）
export function recoverPayer(cfg, intent, intentSig) {
  return recoverTypedDataAddress({
    domain: imputePayDomain(cfg.chainId, cfg.imputepay),
    types: INTENT_TYPES,
    primaryType: 'Intent',
    message: intentMessage(intent),
    signature: intentSig,
  });
}

// intentHash（事件口径的 struct hash）：可离线复现，队列去重/回执对账都用它
export function intentHashOf(cfg, intent) {
  return hashTypedData({
    domain: imputePayDomain(cfg.chainId, cfg.imputepay),
    types: INTENT_TYPES,
    primaryType: 'Intent',
    message: intentMessage(intent),
  });
}

export { verifyTypedData };

// KV 队列存 JSON 用：bigint 全部字符串化（重试时 normalizeIntent 再解析回来）
export function stringifyIntent(intent) {
  return {
    payee: intent.payee,
    payeeAmount: String(intent.payeeAmount),
    token: intent.token,
    maxHelperReward: String(intent.maxHelperReward),
    chainId: String(intent.chainId),
    nonce: String(intent.nonce),
    deadline: String(intent.deadline),
  };
}
