// 批量分组纯函数：同币种聚合 + MAX_BATCH 切块（executeBatch 单次 swap 的前提）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupByToken } from '../src/lib/execute.js';

const item = (token, i) => ({ intent: { token, nonce: BigInt(i) }, intentSig: '0x', payer: '0x1' });
const T1 = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const t1 = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // 小写同币
const T2 = '0xBBBBBBBBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

test('同币（大小写不敏感）聚合，异币分组', () => {
  const groups = groupByToken([item(T1, 1), item(t1, 2), item(T2, 3)]);
  assert.equal(groups.length, 2);
  assert.deepEqual(
    groups.map((g) => g.token),
    [T1, T2],
  );
  assert.equal(groups[0].items.length, 2);
});

test('MAX_BATCH 切块：同组超量时顺序切块', () => {
  const items = Array.from({ length: 13 }, (_, i) => item(T1, i));
  const groups = groupByToken(items, 10);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].items.length, 10);
  assert.equal(groups[1].items.length, 3);
});

test('空输入得空输出', () => {
  assert.deepEqual(groupByToken([], 10), []);
});
