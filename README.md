# SweepPay HelperWorker

付端**第三方 helper** 的参考实现：把 [ImputePay](../../SweepPay_hardhat) 的「机器签名意图 → 任何人可代提交」跑成一个无人值守服务。机器签完名即可下线，本 Worker 盯端口收单，替它把意图送上链。

```
机器（付方）                         HelperWorker（本仓）                    链
  │ POST /intents {intent, 双签名}      │                                  │
  ├──────────────────────────────────────▶ 形状校验 + EIP-712 验签          │
  │                                     │ whitelist / nonce / deadline 预检 │
  │                                     │ eth_call 全流程模拟               │
  │                                     │ 盈利预检：奖励折算 ≥ gas × 1.2    │
  │  ◀─ 200 executed / 202 queued ──────┤ execute / executeBatch 广播 ─────▶│
  │                                     │ （绑 KV 后）202 单 cron 重估行情  │
```

**无许可的含义**：helper 酬劳上限（`maxHelperReward`）由付方签进意图，任何能凑齐 gas 的人都可以提交同一份签名。本 Worker 只是「长得最勤快的那一个」——换掉它不改变协议任何性质。这也是它与 x402 facilitator（生态默认走官方托管结算服务）的本质区别。

## 快速开始

```bash
npm install
npm run sync-registry   # 从 hardhat deployments/all.json 同步链与合约地址 → registry.json
npm test                # 12 例：验签/形状/盈利数学/批量分组
npm run dev             # 本地 wrangler dev（需先配 .dev.vars，见下）
```

**密钥口径（红线）**：`HELPER_PRIVATE_KEY` 是 helper 的 gas 钱包（需持有 native，**不持有用户资金**——用户资金由合约 `transferFrom` 直达收款方，helper 全程只进不出）。

```bash
# 本地：仓库根建 .dev.vars（已被 .gitignore）
echo 'HELPER_PRIVATE_KEY=0x…' > .dev.vars
# 生产：绝不写进 wrangler.jsonc，用 secret
wrangler secret put HELPER_PRIVATE_KEY
```

本地联调推荐直接用 hardhat 测试账户（有 10000 ETH）：

```bash
echo 'HELPER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' > .dev.vars
```

## 部署

```bash
npm run deploy
# 可选绑定重试队列：
wrangler kv namespace create INTENT_QUEUE   # 把 id 填进 wrangler.jsonc 再 deploy
# 可选防滥用：
wrangler secret put HELPER_TOKEN            # 设置后所有 POST 需 Bearer
```

## API

### `POST /intents` — 单笔

```jsonc
// 请求（bigint 一律字符串）
{
  "chainId": "7156777",
  "intent": { "payee": "0x…", "payeeAmount": "1000000", "token": "0x…",
              "maxHelperReward": "10000", "chainId": "7156777",
              "nonce": "1726180000", "deadline": "1726183600" },
  "intentSig": "0x…",   // EIP-712（域 ImputePay/1）
  "permitSig": "0x…"    // EIP-2612；可省（allowance 足够时合约走 fallback）
}
// 200 {"status":"executed","intentHash":"0x…","txHash":"0x…", …}
// 202 {"status":"queued","reason":"无利可图…"}   仅绑了 KV 时
// 422 {"error":"simulate|profit|verify|expired|whitelist", …}
// 409 {"error":"nonce"}（已消费，不重试）
```

### `POST /intents/batch` — 同币种批量（gas 摊薄）

`items: [{intent, intentSig, permitSig?}, …]`，其余同上；内部按币种分组切块（≤ `MAX_BATCH`）后走 `executeBatch`。盈利不过整批进队列，cron 原样重放整批。

### `GET /healthz` — 配置自省

返回 helper 地址、dryRun、各链 ImputePay 地址。

## 配置（wrangler.jsonc vars）

| var | 默认 | 说明 |
|---|---|---|
| `CHAIN_IDS` | registry 全部 | 启用的链，逗号分隔 |
| `RPC_URL_<id>` / `IMPUTEPAY_<id>` | registry | 逐链覆盖（registry 外的自部署链必用） |
| `GAS_BUFFER_X10` | `12` | 盈利门槛 ×1.2（12/10，向上取整） |
| `MIN_OUT_BPS` | `9500` | minNativeOut = 行情折算 × 95%（防三明治） |
| `MAX_BATCH` | `10` | 单次 executeBatch 笔数上限 |
| `DRY_RUN` | `false` | 只模拟与预检，不广播 |
| `HELPER_TOKEN` | 空 | 可选 Bearer 共享密钥 |
| `QUEUE_MAX_ATTEMPTS` | `5` | 重试队列放弃前最多重估次数 |

## 盈利模型

合约 withgas 只保证 helper **不亏**（按 `initialize` 固化的虚拟单价 `gas_price_reward`），**有赚**得链下自己算：

```
expectedNative = router.getAmountsOut(maxHelperReward, [token, wnative])  // pay_config.router 是唯一事实
gasCost        = estimateGas(execute) × eth_gasPrice
出手条件        = expectedNative ≥ gasCost × 1.2
minNativeOut   = expectedNative × 95%（行情被打穿时合约整笔 revert，withgas 兜底）
```

L1 偏移链（Base 等）把 L1 data fee 分量计入 gasPrice 口径后公式不变；费率动态大的链可把 `GAS_BUFFER_X10` 调高。**提交是有利可图的市场行为，不是义务**——不划算就不出手，这正是 nonce 用位图（滞留单不卡付方）的原因。

## 设计边界（不做的事）

- **不托管资金**：无法触碰用户资产，只有 gas 钱包。
- **不做订单簿/撮合**：意图直接结算，无挂单簿。
- **不承诺成交**：出不出手由盈利预检说了算；deadline 内没人提交，意图自然作废。
- **不解析业务**：Worker 不理解「订单」，只理解七字段意图。

## sdk/

[`sdk/`](./sdk/README.md) 是同仓的 TS SDK（`@sweeppay/pay-sdk`，M5 交付物）：`buildIntent → signPermit + signIntent → submitToHelper → waitForExecution` 四步接入，与前端 Playground、hardhat 测试同一套口径。

规格唯一来源：总库 `plans/pay-m1-spec.md`。
