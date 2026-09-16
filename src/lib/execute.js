// 结算执行：预检读 → eth_call 模拟 → 盈利预检 → 广播。
// 单笔 execute / 批量 executeBatch（同币种聚合换币摊薄 gas）。
// 所有失败都以 SettleError(kind) 抛出，路由层据此映射 HTTP 状态码与是否进重试队列。
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import registry from '../../registry.json' with { type: 'json' };
import { evaluateProfit, minOutFromQuote, gasWithHeadroom } from './precheck.js';

const ABIS = {
  ImputePay: registry.contracts.ImputePay.abi,
  Router: registry.contracts.PancakeRouter.abi,
};

// kind 语义（路由层映射）：
//   shape/verify   请求本身的问题（不进队列）
//   expired/nonce/whitelist 链上状态不满足（不进队列——重试也不会变）
//   simulate       合约会 revert（不进队列）
//   profit         现在没利可图（可进队列等行情）
//   send           广播失败（可进队列）
export class SettleError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'SettleError';
    this.kind = kind;
  }
}

export const helperAccount = (pk) => privateKeyToAccount(pk);

const clients = (cfg, account) => {
  const transport = http(cfg.rpc);
  return {
    publicClient: createPublicClient({ transport }),
    walletClient: account
      ? createWalletClient({ account, transport })
      : null,
  };
};

// swap 路由（pay_config.router 是唯一事实）+ wnative；isolate 全局缓存 5 分钟
async function swapRoute(publicClient, cfg) {
  const key = `stapleport-route-${cfg.idStr}`;
  const hit = globalThis[key];
  if (hit && Date.now() - hit.at < 300_000) return hit.v;
  const router = (
    await publicClient.readContract({
      address: cfg.imputepay,
      abi: ABIS.ImputePay,
      functionName: 'pay_config',
    })
  )[1];
  const wnative = await publicClient.readContract({
    address: router,
    abi: ABIS.Router,
    functionName: 'WETH',
  });
  const v = { router, wnative };
  globalThis[key] = { at: Date.now(), v };
  return v;
}

export async function quoteNativeOut(publicClient, route, token, amountIn) {
  const amounts = await publicClient.readContract({
    address: route.router,
    abi: ABIS.Router,
    functionName: 'getAmountsOut',
    args: [amountIn, [token, route.wnative]],
  });
  return amounts[amounts.length - 1];
}

// 链上状态预检：deadline / 白名单 / nonce。任一不过 = 重试也不会好，直接拒
async function preflight(publicClient, cfg, { intent, payer }) {
  if (BigInt(intent.deadline) * 1000n <= BigInt(Date.now())) {
    throw new SettleError('expired', `意图已过 deadline（${intent.deadline}）`);
  }
  const ok = await publicClient.readContract({
    address: cfg.imputepay,
    abi: ABIS.ImputePay,
    functionName: 'whitelist',
    args: [intent.token],
  });
  if (!ok) throw new SettleError('whitelist', '代币不在合约白名单');
  const used = await publicClient.readContract({
    address: cfg.imputepay,
    abi: ABIS.ImputePay,
    functionName: 'isNonceUsed',
    args: [payer, intent.nonce],
  });
  if (used) throw new SettleError('nonce', '该 nonce 已被消费');
}

// eth_call 全流程模拟：签名/白名单/黑名单收款方/余额/allowance 不够……
// 合约会 revert 的都在这里现形，且带合约原文 reason
async function simulate(publicClient, cfg, account, functionName, args) {
  try {
    const { request } = await publicClient.simulateContract({
      address: cfg.imputepay,
      abi: ABIS.ImputePay,
      functionName,
      args,
      account: account.address,
    });
    return request;
  } catch (e) {
    throw new SettleError('simulate', `合约模拟失败：${e.message.slice(0, 200)}`);
  }
}

const gasVerdict = async (publicClient, request, route, token, totalReward, bufferX10) => {
  let gas;
  try {
    gas = await publicClient.estimateContractGas({ ...request });
  } catch (e) {
    throw new SettleError('simulate', `gas 预估失败：${e.message.slice(0, 200)}`);
  }
  const gasPrice = await publicClient.getGasPrice();
  const quote = await quoteNativeOut(publicClient, route, token, totalReward);
  return {
    gas,
    gasPrice,
    quote,
    verdict: evaluateProfit({ expectedNative: quote, gasUnits: gas, gasPrice, bufferX10 }),
  };
};

// ---- 单笔 ----
export async function settleSingle({
  cfg,
  account,
  payer,
  intent,
  intentSig,
  permitSig = '0x',
  minOutBps = 9500n,
  bufferX10 = 12n,
  dryRun = false,
}) {
  const { publicClient, walletClient } = clients(cfg, account);
  await preflight(publicClient, cfg, { intent, payer });
  const request = await simulate(publicClient, cfg, account, 'execute', [
    intent,
    intentSig,
    permitSig,
    0n,
  ]);
  const route = await swapRoute(publicClient, cfg);
  const { gas, gasPrice, quote, verdict } = await gasVerdict(
    publicClient,
    request,
    route,
    intent.token,
    intent.maxHelperReward,
    bufferX10,
  );
  if (!verdict.ok) {
    throw new SettleError(
      'profit',
      `无利可图：奖励折算 ${verdict.expected} < 门槛 ${verdict.threshold}（gas ${verdict.gasCost} × ${bufferX10}/10）`,
    );
  }
  const minNativeOut = minOutFromQuote(quote, minOutBps);
  if (dryRun) return { dryRun: true, gas, gasPrice, quote, minNativeOut, verdict };
  try {
    const txHash = await walletClient.writeContract({
      address: cfg.imputepay,
      abi: ABIS.ImputePay,
      functionName: 'execute',
      args: [intent, intentSig, permitSig, minNativeOut],
      gas: gasWithHeadroom(gas), // 预估值零余量会被 OOG 裸回滚，+20% 上限（预检口径仍用原值；公式收编 Kit）
      account,
    });
    return { txHash, gas, quote, minNativeOut, verdict };
  } catch (e) {
    throw new SettleError('send', `广播失败：${e.message.slice(0, 200)}`);
  }
}

// ---- 批量 ----
// items = [{ intent, intentSig, permitSig, payer }]（已 normalize + 验签）。
// 同币种是 executeBatch 单次 swap 的前提，路由层用 groupByToken 保证，这里再断言一次。
export async function settleBatch({
  cfg,
  account,
  items,
  minOutBps = 9500n,
  bufferX10 = 12n,
  dryRun = false,
}) {
  if (!items?.length) throw new SettleError('shape', 'batch 至少 1 笔');
  const token = items[0].intent.token;
  if (items.some((it) => it.intent.token.toLowerCase() !== token.toLowerCase())) {
    throw new SettleError('shape', '批量内代币不一致');
  }
  const { publicClient, walletClient } = clients(cfg, account);
  for (const it of items) {
    await preflight(publicClient, cfg, { intent: it.intent, payer: it.payer });
  }
  const request = await simulate(
    publicClient,
    cfg,
    account,
    'executeBatch',
    [
      items.map((it) => it.intent),
      items.map((it) => it.intentSig),
      items.map((it) => it.permitSig ?? '0x'),
      items.map(() => 0n),
    ],
  );
  const route = await swapRoute(publicClient, cfg);
  const totalReward = items.reduce((s, it) => s + it.intent.maxHelperReward, 0n);
  const { gas, gasPrice, quote: totalQuote, verdict } = await gasVerdict(
    publicClient,
    request,
    route,
    token,
    totalReward,
    bufferX10,
  );
  if (!verdict.ok) {
    throw new SettleError(
      'profit',
      `批量无利可图：合计折算 ${verdict.expected} < 门槛 ${verdict.threshold}（gas ${verdict.gasCost} × ${bufferX10}/10）`,
    );
  }
  // 逐笔 minNativeOut 按奖励份额比例分摊总折算（合约按 helperOuts ≥ 各自下限复核）
  const minNativeOuts = items.map((it) =>
    minOutFromQuote((totalQuote * it.intent.maxHelperReward) / totalReward, minOutBps),
  );
  if (dryRun) return { dryRun: true, gas, gasPrice, totalQuote, minNativeOuts, verdict };
  try {
    const txHash = await walletClient.writeContract({
      address: cfg.imputepay,
      abi: ABIS.ImputePay,
      functionName: 'executeBatch',
      args: [
        items.map((it) => it.intent),
        items.map((it) => it.intentSig),
        items.map((it) => it.permitSig ?? '0x'),
        minNativeOuts,
      ],
      gas: gasWithHeadroom(gas), // 预估值零余量会被 OOG 裸回滚，+20% 上限（预检口径仍用原值；公式收编 Kit）
      account,
    });
    return { txHash, gas, totalQuote, minNativeOuts, verdict };
  } catch (e) {
    throw new SettleError('send', `广播失败：${e.message.slice(0, 200)}`);
  }
}

// 同币种分组 + 每组按 MAX_BATCH 切块。纯函数（node --test 覆盖）。
// 组内 token 保留首个条目的原始大小写（合约编码吃 bytes20，但保持 checksum 口径干净）
export function groupByToken(items, maxBatch = 10) {
  const groups = new Map();
  for (const it of items) {
    const k = it.intent.token.toLowerCase();
    if (!groups.has(k)) groups.set(k, { token: it.intent.token, list: [] });
    groups.get(k).list.push(it);
  }
  const out = [];
  for (const { token, list } of groups.values()) {
    for (let i = 0; i < list.length; i += maxBatch) {
      out.push({ token, items: list.slice(i, i + maxBatch) });
    }
  }
  return out;
}
