# @stapleport/pay-sdk

Stapleport 付端 TS SDK：把「机器付款」压成四行调用。与 HelperWorker 同仓同源（计划 M5）。

```ts
import { privateKeyToAccount } from 'viem/accounts';
import { buildIntent, signIntent, signPermit, serializeIntent, submitToHelper, waitForExecution } from '@stapleport/pay-sdk';

const machine = privateKeyToAccount(MACHINE_KEY);          // 付方（签完即可下线）
const cfg = { chainId: 78753n, imputepay: '0xA36D…', rpcUrl: 'https://rpc.stapleport.com' };

// 1) 意图：收款方、应收、结算代币、helper 酬劳上限（含费透明收据，签进签名里）
const intent = buildIntent(
  { payee, payeeAmount: 1000000n, token: USDC, maxHelperReward: 10000n },
  cfg,
);

// 2) 双签名：permit（总划扣授权）+ 意图（EIP-712）
const { permitSig } = await signPermit(machine, { ...cfg, token: USDC, tokenName: 'USD Coin', value: intent.payeeAmount + intent.maxHelperReward, deadline: intent.deadline });
const intentSig = await signIntent(machine, cfg, intent);

// 3) 交给任何 helper 代提交（本仓 HelperWorker 是参考实现；无许可 = 换谁都行）
const ack = await submitToHelper('https://stapleport-helper.<你的子域>.workers.dev', {
  chainId: '78753', intent: serializeIntent(intent), intentSig, permitSig,
});

// 4) 等链上 PaymentExecuted 回执（含费透明收据：实付/酬劳/gas 全在事件里）
const receipt = await waitForExecution(cfg, ack.intentHash!);
```

## 构建

```bash
npm run build   # tsc → dist/（main + types）
```

`viem` 为 peerDependency（宿主项目自带，版本 ^2.21）。

## 语义要点

- **签完即下线**：机器不出现在提交路径上；私钥只在第 2 步使用。
- **无退款路径**：入账即终局（与 x402 一致），payee 写错损失归付方。
- **nonce 位图**：任选 uint256，单次消费；滞留单换 nonce 加价重签即可，不会卡死付方。
- **deadline 共用**：意图与 permit 同一 deadline（SDK 约定）。
- **酬劳上限**：`maxHelperReward` 禁 0；竞争性 helper 市场化压低实际酬劳，上限只是付方的容忍度。

规格唯一来源：总库 `plans/pay-m1-spec.md`。
