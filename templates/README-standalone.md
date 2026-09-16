[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Stapleport/HelperWorker_Release)

> [!WARNING]
> **This is an auto-generated release artifact** — do not develop or open PRs here.
> Canonical source & protocol: [Stapleport/Stapleport_HelperWorker](https://github.com/Stapleport/Stapleport_HelperWorker).
>
> **本仓是自动生成的发布产物**——请勿在此开发或提 PR；正本与协议口径见 [Stapleport/Stapleport_HelperWorker](https://github.com/Stapleport/Stapleport_HelperWorker)。

# Stapleport HelperWorker

**[English](#english) | [中文](#中文)**

Stapleport Pay（ImputePay 机器支付）的**自助托管 helper**：机器持双签名下线后，本服务盯端口收单，替它把意图送上链。

> 前置阅读：pay-kit 正典仓 — [/Stapleport_Pay_kit](https://github.com/Stapleport/Stapleport_Pay_kit)

---

<a id="english"></a>
## English

**One sentence**: a permissionless submitter for ImputePay machine payments — anyone can run one, anyone can replace one, and running one is how you earn the helper reward.

### Highlights

- **Zero backend** — one Cloudflare Worker, no database, no accounts. The chain is the ledger.
- **Self-custody friendly** — holds only its own gas wallet. It can touch nobody's funds; the worst case is it burns its own gas on a losing trade.
- **Permissionless by design** — the reward (`maxHelperReward`) is signed into the intent by the payer. Anyone with gas can submit the same signature. Swap this Worker out and nothing about the protocol changes.
- **Failover-ready** — machines can round-robin several helpers and fall back to submitting themselves (`submitWithFailover` in `@stapleport/pay-kit`). Your deployment is one entry in that list, not a dependency.

### How it works

```
machine (payer)                      this Worker                       chain
  │ POST /intents {intent, dual-sig}  │                                │
  ├───────────────────────────────────▶ shape check + EIP-712 verify   │
  │                                   │ whitelist / nonce / deadline    │
  │                                   │ eth_call full-flow simulation   │
  │                                   │ profit check: reward ≥ gas×1.2  │
  │ ◀─ 200 executed / 202 queued ─────┤ execute / executeBatch ────────▶│
```

Every check mirrors an on-chain revert. **Submitting is a profitable market action, not an obligation** — if it doesn't pay, don't.

### Economics

- The payer signs `payeeAmount + maxHelperReward` — the helper's reward is **paid on-chain in the same transaction**, swapped to native and sent to the helper's gas wallet.
- ImputePay charges **no platform fee**: the helper nets the full swapped reward minus its own gas. `withgas` guarantees the helper never loses (the tx reverts otherwise).
- `executeBatch` packs same-token intents into one swap to amortize gas — micro-payments become viable.

### Quick Start

**Option A — one click**: press the Deploy button at the top, then set the secret `HELPER_PRIVATE_KEY` in your Worker settings.

**Option B — CLI**:

```bash
npm install
npx wrangler secret put HELPER_PRIVATE_KEY   # a fresh gas-only wallet
npx wrangler deploy
```

Then point machines at `https://<your-worker>.workers.dev/intents`.

### Configuration

| var | default | notes |
| --- | --- | --- |
| `CHAIN_IDS` | `78753,31337` | chains this helper serves |
| `RPC_URL_<id>` | registry | per-chain RPC override (use your own node) |
| `IMPUTEPAY_<id>` | registry | per-chain ImputePay address override (self-deployed instances) |
| `GAS_BUFFER_X10` | `12` | profit precheck buffer ×10 (1.2 = ×12) |
| `MIN_OUT_BPS` | `9500` | swap slippage floor, basis points (anti-sandwich) |
| `MAX_BATCH` | `10` | max intents per executeBatch |
| `DRY_RUN` | — | set to simulate only; responses return `status:"dry-run"` |
| `HELPER_TOKEN` | — | optional Bearer token to keep scanners off your endpoint |
| `QUEUE_MAX_ATTEMPTS` | `5` | retry attempts for the KV queue |
| `HELPER_PRIVATE_KEY` | secret | **gas-only wallet** — never holds user funds |

Optional KV queue (`INTENT_QUEUE`): unprofitable intents get queued and re-quoted by cron instead of rejected. Off = reject immediately (422).

### Third-party chains

Official chains ship with the bundled `registry.json` (addresses + RPC). For your own chain, deploy ImputePay with the [hardhat scripts](https://github.com/Stapleport/Stapleport) (or reuse an existing instance), then override per-chain env:

```bash
npx wrangler versions upload --var RPC_URL_31338:http://your-rpc --var IMPUTEPAY_31338:0xYourInstance --var CHAIN_IDS:78753,31338
```

Payment history for any chain — official or self-hosted — is queryable straight from the chain via the [Pay dapp](https://stapleport-web-pay.pages.dev) (add the chain under Chain management).

### Security notes

- The helper wallet is **gas-only**. It cannot touch user funds: the contract moves tokens from payer to payee directly; the helper only receives its signed reward.
- Keep `HELPER_PRIVATE_KEY` in Worker secrets, never in `vars/` or git.
- `HELPER_TOKEN` (optional) protects your endpoint from third-party traffic; it is not an auth wall for the protocol — anyone may submit the same signature themselves.

### Local development

```bash
npm install
npm test                                  # 12 cases: verify / shape / profit math / batching
cp .dev.vars.example .dev.vars            # hardhat test key — 31337 ONLY
npx wrangler dev --test-scheduled
```

### Project structure

```
src/
├── worker.js        # routes: POST /intents, /intents/batch, GET /healthz + cron retry
├── config.js        # registry-driven chain config + env overrides
├── lib/
│   ├── verify.js    # intent shape + EIP-712 payer recovery
│   ├── precheck.js  # profit math (thin adapter over vendored worker-kit)
│   ├── execute.js   # simulate → precheck → broadcast
│   └── queue.js     # optional KV retry queue
└── vendor/          # @stapleport/pay-kit + @stapleport/worker-kit (vendored sources)
```

This repository is a **standalone release** of the HelperWorker maintained inside the [Stapleport](https://github.com/Stapleport) monorepo — kit sources are vendored at release time.

### License

MIT

---

<a id="中文"></a>
## 中文

**一句话**：ImputePay 机器支付的无许可提交者——任何人都可以运行一个，任何人都可以换掉一个；运行它就是在赚取 helper 奖励。

### 亮点

- **零后端**——一个 Cloudflare Worker，无数据库、无账户体系，链就是账本。
- **自托管友好**——只持自己的 gas 钱包，碰不到任何用户资金；最坏情况是自己亏一笔 gas。
- **无许可内生**——酬劳（`maxHelperReward`）由付方签进意图，任何能凑齐 gas 的人都可以提交同一份签名；换掉本 Worker，协议性质分毫不变。
- **容灾就绪**——机器可以轮试多个 helper、全挂则自提交（`@stapleport/pay-kit` 的 `submitWithFailover`）。你的部署只是清单里的一项，不是依赖。

### 工作方式

```
机器（付方）                         本 Worker                           链
  │ POST /intents {intent, 双签名}     │                                  │
  ├───────────────────────────────────▶ 形状校验 + EIP-712 验签           │
  │                                   │ 白名单 / nonce / deadline 预检    │
  │                                   │ eth_call 全流程模拟               │
  │                                   │ 盈利预检：奖励 ≥ gas × 1.2        │
  │ ◀─ 200 executed / 202 queued ─────┤ execute / executeBatch 广播 ────▶│
```

每道预检都对应一种链上 revert。**提交是有利可图的市场行为，不是义务**——不划算就不出手。

### 经济账

- 付方签的是 `payeeAmount + maxHelperReward`——helper 奖励**当笔链上直付**，换币成 native 打进 helper 的 gas 钱包。
- ImputePay **无平台抽成**：helper 净得换币后全额减去自付 gas；`withgas` 保证 helper 永远不亏（亏则整笔 revert）。
- `executeBatch` 把同代币意图打包进一次换币摊薄 gas——微支付因此可行。

### 快速开始

**方式 A——一键**：点顶部 Deploy 按钮，然后在 Worker 设置里配好 secret `HELPER_PRIVATE_KEY`。

**方式 B——命令行**：

```bash
npm install
npx wrangler secret put HELPER_PRIVATE_KEY   # 一把全新的、只放 gas 的钱包
npx wrangler deploy
```

然后把机器的提交地址指向 `https://<你的-worker>.workers.dev/intents`。

### 配置

| var | 默认 | 说明 |
| --- | --- | --- |
| `CHAIN_IDS` | `78753,31337` | 本 helper 服务的链 |
| `RPC_URL_<id>` | registry | 逐链 RPC 覆盖（建议用自己的节点） |
| `IMPUTEPAY_<id>` | registry | 逐链 ImputePay 地址覆盖（自部署实例） |
| `GAS_BUFFER_X10` | `12` | 盈利预检缓冲 ×10（1.2 = ×12） |
| `MIN_OUT_BPS` | `9500` | 换币滑点下限（基点，防三明治） |
| `MAX_BATCH` | `10` | executeBatch 单批上限 |
| `DRY_RUN` | — | 设定后只模拟不广播，应答 `status:"dry-run"` |
| `HELPER_TOKEN` | — | 可选 Bearer 令牌，防端口被扫描 |
| `QUEUE_MAX_ATTEMPTS` | `5` | KV 队列重试次数 |
| `HELPER_PRIVATE_KEY` | secret | **只放 gas 的钱包**——永不持有用户资金 |

可选 KV 队列（`INTENT_QUEUE`）：低利单入队、cron 周期重估，不绑则直接 422 拒单。

### 第三方链

官方链内置 `registry.json`（地址 + RPC，随包发布，不依赖任何服务在线）。自有链用 [hardhat 脚本](https://github.com/Stapleport/Stapleport)部署 ImputePay（或复用已有实例），再逐链覆盖 env：

```bash
npx wrangler versions upload --var RPC_URL_31338:http://你的-rpc --var IMPUTEPAY_31338:0x你的实例 --var CHAIN_IDS:78753,31338
```

任何链的支付流水——官方或自托管——都可以在[付端 dapp](https://stapleport-web-pay.pages.dev) 直接查链（链管理里加一条自建链即可），无需经过任何服务。

### 安全须知

- helper 钱包**只放 gas**。合约把代币从付方直付收款方，helper 只收签名里写死的奖励——它没有能力触碰用户资金。
- `HELPER_PRIVATE_KEY` 只进 Worker secrets，绝不进 `vars/` 或 git。
- `HELPER_TOKEN`（可选）用于挡第三方扫描；它不是协议的鉴权墙——任何人本来就可以自己提交同一份签名。

### 本地开发

```bash
npm install
npm test                                  # 12 例：验签 / 形状 / 盈利数学 / 批量
cp .dev.vars.example .dev.vars            # hardhat 测试钥——仅限 31337
npx wrangler dev --test-scheduled
```

### 项目结构

```
src/
├── worker.js        # 路由：POST /intents、/intents/batch、GET /healthz + cron 重试
├── config.js        # registry 驱动链配置 + env 覆盖
├── lib/
│   ├── verify.js    # 意图形状 + EIP-712 付方恢复
│   ├── precheck.js  # 盈利数学（vendored worker-kit 薄适配）
│   ├── execute.js   # 模拟 → 预检 → 广播
│   └── queue.js     # 可选 KV 重试队列
└── vendor/          # @stapleport/pay-kit + @stapleport/worker-kit（vendored 源码）
```

本仓是 HelperWorker 的**独立发布版**，正本维护在 [Stapleport](https://github.com/Stapleport) monorepo——kit 源码在发布时 vendor 进来。

### 许可

MIT
