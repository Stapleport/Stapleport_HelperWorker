// ImputePay helper 本地全链路 E2E：机器双签 → POST /intents → helper 验签+盈利预检 →
// 代提交 execute() 落链 → 链上对账（余额/事件/nonce/合约残留）。
// 前置：8545 链活（automining）、wrangler dev @8799（.dev.vars 配 helper 钥匙）、
//       mock DEX 池子（token/WBNB）有流动性、payer 有足够 MockPermitToken。
// 用法：node scripts/e2e-local.mjs   （退出码 0=全对账通过）
// 签名口径走 @stapleport/pay-kit 正典（buildIntent/signPermit/signIntent/submitToHelper）。
import { createPublicClient, http, decodeEventLog, formatEther } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import {
  buildIntent,
  signPermit,
  signIntent,
  submitToHelper,
  intentHash,
  serializeIntent,
  PAYMENT_EXECUTED,
} from '@stapleport/pay-kit';

const RPC = 'http://127.0.0.1:8545';
const HELPER_URL = 'http://127.0.0.1:8799';
const CHAIN_ID = 31337n;
const IMPUTEPAY = '0xd10b0d5Aa46554AF855803679F02186566665433';
const TOKEN = '0x8a3C06bb0fC7959BB2048b8eCCad20b3DC6c50d3'; // MockPermitToken (MockUSDC, 6dp)
const MNEMONIC = 'test test test test test test test test test test test junk';
const HELPER_ADDR = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'; // #2（worker .dev.vars）

const PAYEE_AMOUNT = 100_000000n; // 收款方应收 100（6dp）
const HELPER_REWARD = 20_000000n; // helper 酬劳上限 20（6dp）
const TOTAL = PAYEE_AMOUNT + HELPER_REWARD;

const cfg = { chainId: CHAIN_ID, imputepay: IMPUTEPAY, rpcUrl: RPC };
const client = createPublicClient({ transport: http(RPC) });

const erc20 = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'name', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
];
const impAbi = [
  { name: 'isNonceUsed', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'whitelist', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] },
];
const balanceOf = (addr, who) => client.readContract({ address: addr, abi: erc20, functionName: 'balanceOf', args: [who] });
const nativeOf = (who) => client.getBalance({ address: who });

const checks = [];
const check = (label, ok, detail) => {
  checks.push({ label, ok });
  console.log(`    ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
};

async function main() {
  const payer = mnemonicToAccount(MNEMONIC, { addressIndex: 3 });
  const payee = mnemonicToAccount(MNEMONIC, { addressIndex: 4 });
  console.log('=== ImputePay helper E2E（本地 31337）===');
  console.log('[0] 参与方:', { payer: payer.address, payee: payee.address, helper: HELPER_ADDR, imputepay: IMPUTEPAY });

  const tokenName = await client.readContract({ address: TOKEN, abi: erc20, functionName: 'name' });
  const whitelisted = await client.readContract({ address: IMPUTEPAY, abi: impAbi, functionName: 'whitelist', args: [TOKEN] });
  console.log('[0] token:', tokenName, '| whitelist:', whitelisted);
  if (!whitelisted) throw new Error('token 不在白名单，流程走不通');

  // 意图：nonce 用时间戳<<32 随机大数，避开位图已用位
  const nonce = (BigInt(Date.now()) << 32n) | BigInt(Math.floor(Math.random() * 2 ** 31));
  if (await client.readContract({ address: IMPUTEPAY, abi: impAbi, functionName: 'isNonceUsed', args: [payer.address, nonce] })) {
    throw new Error('nonce 撞已用位，重跑即可');
  }
  const intent = buildIntent(
    { payee: payee.address, payeeAmount: PAYEE_AMOUNT, token: TOKEN, maxHelperReward: HELPER_REWARD, nonce },
    cfg,
    { ttlSeconds: 7 * 24 * 3600 },
  );
  console.log('[1] 意图:', { ...serializeIntent(intent), intentHash: intentHash(intent) });

  // 双签（EIP-2612 permit + EIP-712 intent），签完机器即可下线
  const deadline = intent.deadline;
  const { permitSig } = await signPermit(payer, {
    ...cfg,
    token: TOKEN,
    tokenName,
    value: TOTAL,
    deadline,
  });
  const intentSig = await signIntent(payer, cfg, intent);
  console.log('[2] 双签完成: permit', permitSig.slice(0, 20) + '…', '| intent', intentSig.slice(0, 20) + '…');

  // 对账基线
  const [payeeBal0, payerBal0, helperNat0, contractTok0] = await Promise.all([
    balanceOf(TOKEN, payee.address),
    balanceOf(TOKEN, payer.address),
    nativeOf(HELPER_ADDR),
    balanceOf(TOKEN, IMPUTEPAY),
  ]);
  console.log('[3] 基线: payee token', payeeBal0, '| payer token', payerBal0, '| helper native', formatEther(helperNat0));

  // POST 给 helper（无许可代提交入口）
  const ack = await submitToHelper(HELPER_URL, {
    chainId: String(CHAIN_ID),
    intent: serializeIntent(intent),
    intentSig,
    permitSig,
  });
  console.log('[4] helper 应答:', JSON.stringify(ack, null, 2));
  if (ack.status !== 'executed' || !ack.txHash) {
    throw new Error(`helper 未代提交（status=${ack.status}），中止`);
  }

  // 轮询回执（automining，最多 60s）
  let receipt = null;
  for (let i = 0; i < 60 && !receipt; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    receipt = await client.getTransactionReceipt({ hash: ack.txHash }).catch(() => null);
  }
  if (!receipt) throw new Error(`60s 内未等到回执 tx=${ack.txHash}`);
  if (receipt.status !== 'success') throw new Error(`tx 落链但 revert: ${ack.txHash}`);
  console.log('[5] tx 已落链:', ack.txHash, '| block', receipt.blockNumber, '| gasUsed', receipt.gasUsed);

  const ev = receipt.logs
    .map((l) => {
      try { return { ...decodeEventLog({ abi: [PAYMENT_EXECUTED], data: l.data, topics: l.topics }), address: l.address }; }
      catch { return null; }
    })
    .filter((e) => e && e.eventName === 'PaymentExecuted' && e.address.toLowerCase() === IMPUTEPAY.toLowerCase())
    .map((e) => e.args)[0];
  if (!ev) throw new Error('回执里没有 PaymentExecuted 事件');

  // 链上对账
  const [payeeBal1, payerBal1, helperNat1, contractTok1, nonceUsed] = await Promise.all([
    balanceOf(TOKEN, payee.address),
    balanceOf(TOKEN, payer.address),
    nativeOf(HELPER_ADDR),
    balanceOf(TOKEN, IMPUTEPAY),
    client.readContract({ address: IMPUTEPAY, abi: impAbi, functionName: 'isNonceUsed', args: [payer.address, intent.nonce] }),
  ]);
  const effGasPrice = receipt.effectiveGasPrice ?? receipt.gasPrice ?? 0n;
  const gasCost = receipt.gasUsed * effGasPrice;
  const helperDelta = helperNat1 - helperNat0;

  console.log('[6] 对账:');
  check('事件 intentHash 与意图口径一致', ev.intentHash === intentHash(intent), ev.intentHash);
  check('事件 payer = 付款机器 #3', ev.payer.toLowerCase() === payer.address.toLowerCase(), ev.payer);
  check('事件 payee = 收款方 #4', ev.payee.toLowerCase() === payee.address.toLowerCase(), ev.payee);
  check('事件 token = MockPermitToken', ev.token.toLowerCase() === TOKEN.toLowerCase(), ev.token);
  check('事件 helper = worker 钥匙 #2', ev.helper.toLowerCase() === HELPER_ADDR.toLowerCase(), ev.helper);
  check('事件 payeeAmount = 100', ev.payeeAmount === PAYEE_AMOUNT, ev.payeeAmount.toString());
  check('payee 实收 = 100', payeeBal1 - payeeBal0 === PAYEE_AMOUNT, (payeeBal1 - payeeBal0).toString());
  check('payer 实扣 = 120（100+20）', payerBal0 - payerBal1 === TOTAL, (payerBal0 - payerBal1).toString());
  check('nonce 已消费', nonceUsed === true, `nonce=${intent.nonce}`);
  check('合约无代币残留', contractTok1 === contractTok0 && contractTok1 === 0n, contractTok1.toString());
  check('事件 helperNativeOut ≥ gas 成本（withgas 兜底）', ev.helperNativeOut >= gasCost, `out=${ev.helperNativeOut} gasCost=${gasCost}`);
  check('helper 链上净余额不降（实得−gas ≥ 0）', helperDelta >= 0n, `delta=${helperDelta} wei`);
  check('helper 实得与事件一致（delta+gasCost=helperNativeOut）', helperDelta + gasCost === ev.helperNativeOut, `${helperDelta}+${gasCost}=${ev.helperNativeOut}`);

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n=== ${failed.length === 0 ? '验收通过：机器双签 → helper 代提交 → 落链 → 全对账成立' : `验收失败（${failed.length} 项不过）`} ===`);
  if (failed.length) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error('E2E FATAL:', e.message);
    process.exit(1);
  });
