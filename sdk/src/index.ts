// @stapleport/pay-sdk：付端接入的最小完整闭环。
// 机器侧四步：buildIntent → signPermit + signIntent（双签名，签完即可下线）→
// submitToHelper（任何 helper 都行，本仓的 HelperWorker 是参考实现）→ waitForExecution。
// 口径唯一来源：总库 plans/pay-m1-spec.md；与合约 EIP712Upgradeable("ImputePay","1") 逐字一致。
import {
  type Address,
  type Chain,
  type Hash,
  type Log,
  createPublicClient,
  http,
  keccak256,
  toHex,
  encodeAbiParameters,
  parseAbiItem,
} from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';

// ---- 意图 schema（v2 七字段，成员顺序即合约 struct 顺序）----

export interface Intent {
  payee: Address;
  payeeAmount: bigint;
  token: Address;
  maxHelperReward: bigint;
  chainId: bigint;
  nonce: bigint;
  deadline: bigint;
}

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
} as const;

export const imputePayDomain = (chainId: bigint, verifyingContract: Address) => ({
  name: 'ImputePay',
  version: '1',
  chainId,
  verifyingContract,
});

export interface ImputePayRef {
  chainId: bigint;
  imputepay: Address;
}

export interface IntentInput {
  payee: Address;
  payeeAmount: bigint;
  token: Address;
  maxHelperReward: bigint;
  chainId?: bigint;
  nonce?: bigint;
  deadline?: bigint;
}

/** 组装意图；nonce/deadline 缺省时自动补（nonce 用时间戳低位，deadline 1 小时） */
export function buildIntent(
  input: Omit<IntentInput, 'chainId'>,
  cfg: ImputePayRef,
  { now = Date.now(), ttlSeconds = 3600 }: { now?: number; ttlSeconds?: number } = {},
): Intent {
  return {
    payee: input.payee,
    payeeAmount: input.payeeAmount,
    token: input.token,
    maxHelperReward: input.maxHelperReward,
    chainId: cfg.chainId,
    nonce: input.nonce ?? BigInt(now) % 4294967296n,
    deadline: input.deadline ?? BigInt(Math.floor(now / 1000) + ttlSeconds),
  };
}

/** intentHash（事件口径 struct hash，规格 §1.2/§3）：keccak(abi.encode(TYPEHASH, 七字段))。
 *  注意不是 EIP-712 digest——链上 PaymentExecuted 事件带的、waitForExecution 对账用的都是它。 */
export function intentHash(cfg: ImputePayRef, intent: Intent): Hash {
  const typehash = keccak256(
    toHex('Intent(address payee,uint256 payeeAmount,address token,uint256 maxHelperReward,uint256 chainId,uint256 nonce,uint256 deadline)'),
  );
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }, { type: 'address' },
        { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' },
      ],
      [typehash, intent.payee, intent.payeeAmount, intent.token, intent.maxHelperReward, intent.chainId, intent.nonce, intent.deadline],
    ),
  );
}

// ---- 双签名 ----

/** 意图签名（EIP-712，域含 chainId + verifyingContract） */
export async function signIntent(account: PrivateKeyAccount, cfg: ImputePayRef, intent: Intent): Promise<Hash> {
  return account.signTypedData({
    domain: imputePayDomain(cfg.chainId, cfg.imputepay),
    types: INTENT_TYPES,
    primaryType: 'Intent',
    message: { ...intent },
  });
}

export interface PermitBundle {
  permitSig: Hash;
  deadline: bigint;
  nonce: bigint;
}

export interface PermitInput extends ImputePayRef {
  token: Address;
  tokenName: string;
  value: bigint;
  rpcUrl?: string;
  deadline: bigint; // 与意图共用（SDK 约定）
}

/**
 * permit 签名（EIP-2612）：spender = ImputePay、value = 总划扣（payeeAmount + maxHelperReward）、
 * deadline 与意图共用（SDK 约定，省一段 calldata）。tokenName 从代币合约 `name()` 读，
 * OZ 系 permit 域 version 固定 "1"。
 */
export async function signPermit(account: PrivateKeyAccount, cfg: PermitInput): Promise<PermitBundle> {
  const client = createPublicClient({ transport: http(cfg.rpcUrl) });
  const permitTypes = {
    Permit: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
  } as const;
  const permitNonce = (await client.readContract({
    address: cfg.token,
    abi: [{ name: 'nonces', type: 'function', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'uint256' }] }],
    functionName: 'nonces',
    args: [account.address],
  })) as bigint;
  const deadline = cfg.deadline;
  const permitSig = await account.signTypedData({
    domain: { name: cfg.tokenName, version: '1', chainId: cfg.chainId, verifyingContract: cfg.token },
    types: permitTypes,
    primaryType: 'Permit',
    message: { owner: account.address, spender: cfg.imputepay, value: cfg.value, nonce: permitNonce, deadline },
  });
  return { permitSig, deadline, nonce: permitNonce };
}

// ---- 提交与等待 ----

/** 意图 → JSON 安全对象（bigint 字符串化）；helper 端 normalizeIntent 会解析回来 */
export function serializeIntent(intent: Intent): Record<string, string> {
  return {
    payee: intent.payee,
    payeeAmount: intent.payeeAmount.toString(),
    token: intent.token,
    maxHelperReward: intent.maxHelperReward.toString(),
    chainId: intent.chainId.toString(),
    nonce: intent.nonce.toString(),
    deadline: intent.deadline.toString(),
  };
}

export interface HelperAck {
  status: 'executed' | 'dry-run' | 'queued' | 'rejected';
  intentHash?: Hash;
  txHash?: Hash;
  reason?: string;
  [k: string]: unknown;
}

/** 提交给 helper（本仓 HelperWorker 的 /intents 即参考实现）；token 为可选的共享密钥 */
export async function submitToHelper(
  baseUrl: string,
  payload: Record<string, unknown>,
  { token, batch = false, fetchImpl = fetch }: { token?: string; batch?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<HelperAck> {
  const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/intents${batch ? '/batch' : ''}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  const body = (await res.json()) as HelperAck;
  if (!res.ok && !body.status) throw new Error(`helper ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

const PAYMENT_EXECUTED = parseAbiItem(
  'event PaymentExecuted(bytes32 indexed intentHash, address indexed payer, address indexed payee, address token, uint256 payeeAmount, address helper, uint256 helperNativeOut, uint256 gasUsed)',
);

export interface ExecutionReceipt {
  intentHash: Hash;
  payer: Address;
  payee: Address;
  token: Address;
  payeeAmount: bigint;
  helper: Address;
  helperNativeOut: bigint;
  gasUsed: bigint;
  txHash: Hash;
  blockNumber: bigint;
}

/**
 * 等待某意图被执行（轮询链上 PaymentExecuted 事件；demo/联盟链体量从 0 扫，
 * 主网量级请传入 fromBlock 收窄）。
 */
export async function waitForExecution(
  cfg: ImputePayRef & { rpcUrl?: string; chain?: Chain },
  intentHash: Hash,
  { timeoutMs = 120_000, pollMs = 4_000, fromBlock = 0n }: { timeoutMs?: number; pollMs?: number; fromBlock?: bigint } = {},
): Promise<ExecutionReceipt | null> {
  const client = createPublicClient({ transport: http(cfg.rpcUrl) });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const logs = await client.getLogs({
      address: cfg.imputepay,
      event: PAYMENT_EXECUTED,
      args: { intentHash },
      fromBlock,
    });
    if (logs.length) {
      const l = logs[logs.length - 1] as Log<bigint, number, false, typeof PAYMENT_EXECUTED, true>;
      const a = l.args;
      return {
        intentHash: a.intentHash!,
        payer: a.payer!,
        payee: a.payee!,
        token: a.token!,
        payeeAmount: a.payeeAmount!,
        helper: a.helper!,
        helperNativeOut: a.helperNativeOut!,
        gasUsed: a.gasUsed!,
        txHash: l.transactionHash,
        blockNumber: l.blockNumber,
      };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}
