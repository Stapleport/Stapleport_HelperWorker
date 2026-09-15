// 验签与形状校验：真实签名 → 恢复付方；篡改与非法形状逐一现形。
import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { normalizeIntent, recoverPayer, intentHashOf, imputePayDomain, stringifyIntent, INTENT_TYPES } from '../src/lib/verify.js';

const cfg = { chainId: 31337n, imputepay: '0x60FB019a3C221a4d691B418Df58150569f7D6Bc4', idStr: '31337' };
const wallet = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');

const rawIntent = () => ({
  payee: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
  payeeAmount: '1000000000',
  token: '0x3c74E57fE97c2b8e36A989deDB80Ec32a52C4fD0',
  maxHelperReward: '100000000',
  chainId: '31337',
  nonce: '42',
  deadline: String(Math.floor(Date.now() / 1000) + 3600),
});

test('合法意图：normalize 收敛 bigint，签名恢复出付方', async () => {
  const { intent } = normalizeIntent(rawIntent(), { chainId: 31337n });
  assert.equal(typeof intent.payeeAmount, 'bigint');
  const sig = await wallet.signTypedData({
    domain: imputePayDomain(cfg.chainId, cfg.imputepay),
    types: INTENT_TYPES,
    primaryType: 'Intent',
    message: intent,
  });
  const payer = await recoverPayer(cfg, intent, sig);
  assert.equal(payer.toLowerCase(), wallet.address.toLowerCase());
});

test('字段被篡改后验签恢复出别的地址（≠ 付方即拒绝的依据）', async () => {
  const { intent } = normalizeIntent(rawIntent(), { chainId: 31337n });
  const sig = await wallet.signTypedData({
    domain: imputePayDomain(cfg.chainId, cfg.imputepay),
    types: INTENT_TYPES,
    primaryType: 'Intent',
    message: intent,
  });
  const tampered = { ...intent, payeeAmount: intent.payeeAmount + 1n };
  const payer = await recoverPayer(cfg, tampered, sig);
  assert.notEqual(payer.toLowerCase(), wallet.address.toLowerCase());
});

test('intentHash 与字段顺序无关（具名消息构造）', async () => {
  const a = normalizeIntent(rawIntent()).intent;
  const raw = rawIntent();
  const flipped = {
    deadline: raw.deadline, nonce: raw.nonce, chainId: raw.chainId,
    maxHelperReward: raw.maxHelperReward, token: raw.token, payeeAmount: raw.payeeAmount, payee: raw.payee,
  };
  const b = normalizeIntent(flipped).intent;
  assert.equal(intentHashOf(cfg, a), intentHashOf(cfg, b));
});

test('形状校验：reward 禁 0 / chainId 错配 / 坏地址 / 非整数', () => {
  assert.match(normalizeIntent({ ...rawIntent(), maxHelperReward: '0' }).error, /maxHelperReward/);
  assert.match(normalizeIntent(rawIntent(), { chainId: 78753n }).error, /chainId 错配/);
  assert.match(normalizeIntent({ ...rawIntent(), payee: '0xdead' }).error, /地址非法/);
  assert.match(normalizeIntent({ ...rawIntent(), payeeAmount: '1.5' }).error, /非负整数/);
  assert.match(normalizeIntent(null).error, /对象/);
});

test('stringifyIntent ⇄ normalizeIntent 往返（KV 队列存取口径）', () => {
  const { intent } = normalizeIntent(rawIntent(), { chainId: 31337n });
  const round = normalizeIntent(JSON.parse(JSON.stringify(stringifyIntent(intent))), { chainId: 31337n });
  assert.deepEqual(round.intent, intent);
});
