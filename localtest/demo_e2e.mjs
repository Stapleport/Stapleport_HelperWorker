// HelperWorker 本地 E2E 演示：hardhat 本地链 + wrangler dev + 本脚本（SDK 四步造单）。
// 前置（一次性）：
//   1) 主仓部署 mock DEX + MockPermitToken + ImputePay 到 127.0.0.1:8545，
//      记下 Router/Token/ImputePay 地址（README「本地演示」节）
//   2) well-known 测试钥注资/备币：
//      helper 0xf39F…92266（0xac0974…钥）hardhat_setBalance 10 ETH；
//      payer 0x7099…79C8（0x59c6995…钥）mint 结算币
//   3) wrangler dev --port 8799 \
//        --var RPC_URL_31337:http://127.0.0.1:8545 \
//        --var IMPUTEPAY_31337:<ImputePay> --var CHAIN_IDS:31337 \
//        --var HELPER_PRIVATE_KEY:0xac0974…
// 运行：node localtest/demo_e2e.mjs（地址改成本轮部署输出）
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http } from 'viem';
import {
    buildIntent, signIntent, signPermit, serializeIntent, submitToHelper, waitForExecution,
} from '../sdk/dist/index.js';

// ---- 本轮部署参数（按 demo/部署输出改）----
const RPC = process.env.E2E_RPC ?? 'http://127.0.0.1:8545';
const HELPER_URL = process.env.E2E_HELPER_URL ?? 'http://127.0.0.1:8799';
const CHAIN_ID = 31337n;
const IMPUTEPAY = process.env.E2E_IMPUTEPAY ?? '0x60FB019a3C221a4d691B418Df58150569f7D6Bc4';
const TOKEN = process.env.E2E_TOKEN ?? '0x16E781D26B1AA8Ac8827eEC245F5d19721257d0e';
const TOKEN_NAME = process.env.E2E_TOKEN_NAME ?? 'MockUSDC';
const PAYEE = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'; // well-known account2（只收）
const PAYER_PK = process.env.E2E_PAYER_PK ?? '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const PAYEE_AMOUNT = 100_000000n;
const HELPER_REWARD = 20_000000n;

const machine = privateKeyToAccount(PAYER_PK);
const cfg = { chainId: CHAIN_ID, imputepay: IMPUTEPAY, rpcUrl: RPC };

// SDK 四步：buildIntent → signPermit + signIntent → submitToHelper → waitForExecution
// nonce 缺省走 buildIntent 的时间戳自动生成（链上重跑免撞位图；要复现固定值用 E2E_NONCE）
const intent = buildIntent(
    {
        payee: PAYEE, payeeAmount: PAYEE_AMOUNT, token: TOKEN, maxHelperReward: HELPER_REWARD,
        ...(process.env.E2E_NONCE ? { nonce: BigInt(process.env.E2E_NONCE) } : {}),
    },
    cfg,
);
const { permitSig } = await signPermit(machine, {
    ...cfg, token: TOKEN, tokenName: TOKEN_NAME,
    value: intent.payeeAmount + intent.maxHelperReward, deadline: intent.deadline,
});
const intentSig = await signIntent(machine, cfg, intent);
console.log('[1] 双签名完成 payer=', machine.address, 'nonce=', intent.nonce.toString());

const client = createPublicClient({ transport: http(RPC) });
const erc20 = [{
    name: 'balanceOf', type: 'function', stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'uint256' }],
}];
const payeeBefore = await client.readContract({ address: TOKEN, abi: erc20, functionName: 'balanceOf', args: [PAYEE] });

const ack = await submitToHelper(HELPER_URL, {
    chainId: CHAIN_ID.toString(),
    intent: serializeIntent(intent),
    intentSig,
    permitSig,
});
console.log('[2] helper 应答:', JSON.stringify(ack, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
if (ack.status !== 'executed') {
    console.log('worker 未执行（status=' + ack.status + ' reason=' + (ack.reason ?? '') + '）');
    process.exit(2);
}

const receipt = await waitForExecution(cfg, ack.intentHash, { timeoutMs: 30_000, pollMs: 2_000 });
const payeeAfter = await client.readContract({ address: TOKEN, abi: erc20, functionName: 'balanceOf', args: [PAYEE] });
console.log('[3] 链上对账:', {
    txHash: receipt?.txHash,
    helper: receipt?.helper,
    helperNativeOut: receipt?.helperNativeOut?.toString(),
    payeeDelta: (payeeAfter - payeeBefore).toString(),
});
const ok = receipt && payeeAfter - payeeBefore === PAYEE_AMOUNT && receipt.helperNativeOut > 0n;
console.log(ok
    ? '=== HelperWorker E2E 验收通过 ✓（SDK 造单 → worker 预检/执行 → 收款方到账 → helper 得 native 酬劳）==='
    : '=== 对账不符 ✗ ===');
process.exit(ok ? 0 : 1);
