// 内部 tick 口单测（触发源迁移：自有 cron → Stapleport_Scheduler 唤醒面 worker.fetch）。
// 断言源=派单钉死语义：正确 token POST=200+执行摘要（含时间戳）；错 token/缺头/env 未配
// INTERNAL_TICK_TOKEN（fail-closed）=401；非 tick 路径与非 GET/POST 方法=404；
// GET=last_run 只读查询（同 token 门）且随 POST 推进。
// 防真跑任务口径（同 Exchange Executor 先例）：空 env 无 INTENT_QUEUE binding →
// drainQueue 首行 no-op，任务零执行；鉴权与响应形状才是本测对象。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const TOKEN = 'unit-tick-token';
const req = (path, { method = 'POST', token = TOKEN } = {}) =>
  new Request(`https://helper.internal${path}`, {
    method,
    headers: token === null ? {} : { 'x-internal-token': token },
  });

test('tick 口：正确 token POST=200+执行摘要（时间戳；空 env=队列空转轮）', async () => {
  const res = await worker.fetch(req('/internal/tick'), { INTERNAL_TICK_TOKEN: TOKEN });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.executed, true); // 空 env 无 KV=drainQueue 空转即完成（任务体零执行）
  assert.ok(Number.isFinite(j.at) && j.at > 0, `摘要缺时间戳：${JSON.stringify(j)}`);
});

test('tick 口：错 token=401（含 env 未配 INTERNAL_TICK_TOKEN 的 fail-closed 与缺头）', async () => {
  const wrong = await worker.fetch(req('/internal/tick', { token: 'wrong' }), { INTERNAL_TICK_TOKEN: TOKEN });
  assert.equal(wrong.status, 401);
  const unset = await worker.fetch(req('/internal/tick'), {});
  assert.equal(unset.status, 401);
  const none = await worker.fetch(req('/internal/tick', { token: null }), { INTERNAL_TICK_TOKEN: TOKEN });
  assert.equal(none.status, 401); // 头缺失=不符
});

test('tick 口：非 GET/POST 方法=404；非 tick 路径落公网路由=404（token 不参与）', async () => {
  assert.equal((await worker.fetch(req('/internal/tick', { method: 'PUT' }), { INTERNAL_TICK_TOKEN: TOKEN })).status, 404);
  // 非 tick 路径不走 tick 门：POST 会被公网面 HELPER_TOKEN fail-closed 门 503 拦下（另行断言），
  // GET 直接命中路由 not found=404。
  assert.equal((await worker.fetch(req('/internal/other', { method: 'GET', token: 'wrong' }), { INTERNAL_TICK_TOKEN: TOKEN })).status, 404);
  assert.equal((await worker.fetch(req('/__scheduled', { method: 'GET' }), { INTERNAL_TICK_TOKEN: TOKEN })).status, 404);
  const gated = await worker.fetch(req('/__scheduled'), { INTERNAL_TICK_TOKEN: TOKEN });
  assert.equal(gated.status, 503); // POST 未知路径=公网面 fail-closed（未配 HELPER_TOKEN），非 tick 门产物
});

test('tick 口：GET=last_run 只读查询（同 token 门）且随 POST 推进', async () => {
  const first = await worker.fetch(req('/internal/tick'), { INTERNAL_TICK_TOKEN: TOKEN });
  const at1 = (await first.json()).at;
  await new Promise((r) => setTimeout(r, 5)); // 跨毫秒，保证推进可断言
  await worker.fetch(req('/internal/tick'), { INTERNAL_TICK_TOKEN: TOKEN });
  const res = await worker.fetch(req('/internal/tick', { method: 'GET' }), { INTERNAL_TICK_TOKEN: TOKEN });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.ok(j.last_run && Number.isFinite(j.last_run.at), `last_run 未落：${JSON.stringify(j)}`);
  assert.ok(j.last_run.at > at1, `last_run 未推进：at1=${at1} at2=${j.last_run.at}`);
  const bad = await worker.fetch(req('/internal/tick', { method: 'GET', token: 'wrong' }), { INTERNAL_TICK_TOKEN: TOKEN });
  assert.equal(bad.status, 401);
});
