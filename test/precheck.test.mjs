// 盈利预检纯数学：×1.2 门槛、bps 折扣、边界取整。
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateProfit, minOutFromQuote } from '../src/lib/precheck.js';

test('刚好 1.2 倍算过线，1.19 倍算不过', () => {
  // gasCost = 1000；门槛 = 1000×12/10 = 1200
  const v = evaluateProfit({ expectedNative: 1200n, gasUnits: 1000n, gasPrice: 1n });
  assert.equal(v.ok, true);
  assert.equal(v.threshold, 1200n);
  const v2 = evaluateProfit({ expectedNative: 1199n, gasUnits: 1000n, gasPrice: 1n });
  assert.equal(v2.ok, false);
});

test('门槛向上取整（宁可错杀）', () => {
  // gasCost = 5 → 门槛 = 5×12/10 = 6 向上取整（5×12+9)/10 = 6
  const v = evaluateProfit({ expectedNative: 6n, gasUnits: 5n, gasPrice: 1n });
  assert.equal(v.threshold, 6n);
  assert.equal(v.ok, true);
  const v3 = evaluateProfit({ expectedNative: 5n, gasUnits: 5n, gasPrice: 1n });
  assert.equal(v3.ok, false);
});

test('margin = 折算 − 真实成本（可以为正但不过 1.2 线）', () => {
  const v = evaluateProfit({ expectedNative: 1100n, gasUnits: 1000n, gasPrice: 1n });
  assert.equal(v.margin, 100n);
  assert.equal(v.ok, false);
});

test('minOutFromQuote：95% 折扣，bigint 不丢精度', () => {
  assert.equal(minOutFromQuote(1_000_000n), 950_000n);
  assert.equal(minOutFromQuote(1n, 9500n), 0n); // 极小额向下取整为 0
  assert.equal(minOutFromQuote('2000000', 9000n), 1_800_000n); // 字符串入参也收敛
});
