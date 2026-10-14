// 入口路由：POST /intents（单笔）| POST /intents/batch（同币种批量）| GET /healthz。
// scheduled：drain 重试队列（绑了 KV 才有内容），有利可图的单子趁行情代提交。
// 角色语义：调用方是「机器」（签完即可下线），本 Worker 是无许可 helper 之一——
// 换任何 helper 都能提交同一份签名，这正是意图协议的无许可意义。
import { listChains, chainNames } from './config.js';
import { normalizeIntent, recoverPayer, intentHashOf, stringifyIntent } from './lib/verify.js';
import { settleSingle, settleBatch, groupByToken, SettleError, helperAccount } from './lib/execute.js';
import { safeEqual, parseBearer } from '@stapleport/worker-kit';
import * as queue from './lib/queue.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
// 应答里带链上数值（gas/quote/verdict 等），BigInt 统一字符串化
const json = (data, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(data, (_, v) => (typeof v === 'bigint' ? v.toString() : v), null, 2) + '\n', {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extraHeaders },
  });

const account = (env) => (env.HELPER_PRIVATE_KEY ? helperAccount(env.HELPER_PRIVATE_KEY) : null);

// ---- 防滥用门（F-007）----
// 三道闸：HELPER_TOKEN 必配（未配 fail-closed）；POST 请求体字节上限；按源 IP 限速。
// 默认值可被 env 覆盖（MAX_BODY_BYTES / RATE_LIMIT_PER_MIN）。GET /healthz 永远开放。
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024; // 1MB
const DEFAULT_RATE_LIMIT_PER_MIN = 60;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_KEYS = 10_000; // 单隔离实例内 IP 桶上限，防无界增长（多实例不共享，尽力而为）
const rlBuckets = new Map(); // ip -> { count, resetAt }
let warnedNoToken = false;

// HELPER_TOKEN 必配：Workers 无启动钩子，借首个请求触发一次性告警。
function warnIfTokenMissing(env) {
  if (!env.HELPER_TOKEN && !warnedNoToken) {
    warnedNoToken = true;
    console.warn('[config] HELPER_TOKEN 未配置：所有 POST 将 503 拒绝；请 `wrangler secret put HELPER_TOKEN` 后重新部署');
  }
}

function clientIp(request) {
  return (
    request.headers.get('cf-connecting-ip') ||
    (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'unknown'
  );
}

// 固定窗口（60s）按 IP 计数；超限回 429 + Retry-After。
function checkRateLimit(env, request) {
  const limit = Number(env.RATE_LIMIT_PER_MIN || DEFAULT_RATE_LIMIT_PER_MIN);
  const now = Date.now();
  if (rlBuckets.size > RATE_MAX_KEYS) {
    for (const [k, v] of rlBuckets) if (v.resetAt <= now) rlBuckets.delete(k);
    if (rlBuckets.size > RATE_MAX_KEYS) {
      let n = 0;
      for (const k of rlBuckets.keys()) {
        rlBuckets.delete(k);
        if (++n >= RATE_MAX_KEYS / 2) break;
      }
    }
  }
  const ip = clientIp(request);
  let b = rlBuckets.get(ip);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rlBuckets.set(ip, b);
  }
  b.count++;
  if (b.count > limit) {
    const retryAfter = Math.max(1, Math.ceil((b.resetAt - now) / 1000));
    return json({ error: 'rate_limited', message: `请求过于频繁（上限 ${limit}/分钟）` }, 429, {
      'retry-after': String(retryAfter),
    });
  }
  return null;
}

// 所有 POST 必须带 Bearer（HELPER_TOKEN 已在入口判空）。常数时间比较。
function checkAuth(env, request) {
  return safeEqual(parseBearer(request) ?? '', env.HELPER_TOKEN);
}

const opts = (env) => ({
  minOutBps: BigInt(env.MIN_OUT_BPS || 9500),
  bufferX10: BigInt(env.GAS_BUFFER_X10 || 12),
  dryRun: (env.DRY_RUN || 'false') === 'true',
});

const pickChain = (env, chainId) => {
  const cfg = listChains(env).find((c) => c.idStr === String(chainId));
  if (!cfg) throw new SettleError('shape', `未配置链 ${chainId}（已配置：${chainNames(listChains(env))}）`);
  return cfg;
};

// 单笔：验证 → 预检 → 模拟 → 盈利判定 → 提交 / 进队列
async function handleSingle(env, body) {
  const acc = account(env);
  if (!acc) return json({ error: 'helper_not_configured', message: '本 Worker 未配置 HELPER_PRIVATE_KEY' }, 503);
  const cfg = pickChain(env, body.chainId);
  const norm = normalizeIntent(body.intent, { chainId: cfg.chainId });
  if (norm.error) throw new SettleError('shape', norm.error);
  const intent = norm.intent;
  let payer;
  try {
    payer = await recoverPayer(cfg, intent, body.intentSig);
  } catch {
    throw new SettleError('verify', '意图签名验证失败');
  }
  const h = intentHashOf(cfg, intent);
  try {
    const r = await settleSingle({
      cfg,
      account: acc,
      payer,
      intent,
      intentSig: body.intentSig,
      permitSig: body.permitSig || '0x',
      ...opts(env),
    });
    return json({ status: r.dryRun ? 'dry-run' : 'executed', intentHash: h, payer, ...r });
  } catch (e) {
    if (e.kind === 'profit' && (await queue.enqueue(env, queue.queueKey(cfg.idStr, h), {
      type: 'single',
      chainId: cfg.idStr,
      intent: stringifyIntent(intent),
      intentSig: body.intentSig,
      permitSig: body.permitSig || '0x',
      payer,
      intentHash: h,
      attempts: 0,
      queuedAt: Date.now(),
    }))) {
      return json({ status: 'queued', intentHash: h, reason: e.message }, 202);
    }
    throw e;
  }
}

// 批量：逐笔验证（坏一笔整批 400，指出序号）→ 同币种分组 → executeBatch。
// 盈利不过时整批进队列（cron 端原样重放整批，保住 gas 摊薄）
async function handleBatch(env, body) {
  const acc = account(env);
  if (!acc) return json({ error: 'helper_not_configured', message: '本 Worker 未配置 HELPER_PRIVATE_KEY' }, 503);
  const cfg = pickChain(env, body.chainId);
  const rawItems = body.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new SettleError('shape', 'items 必须是非空数组');
  }
  const o = opts(env);
  const items = [];
  for (let i = 0; i < rawItems.length; i++) {
    const it = rawItems[i] || {};
    const norm = normalizeIntent(it.intent, { chainId: cfg.chainId });
    if (norm.error) throw new SettleError('shape', `items[${i}] ${norm.error}`);
    let payer;
    try {
      payer = await recoverPayer(cfg, norm.intent, it.intentSig);
    } catch {
      throw new SettleError('verify', `items[${i}] 意图签名验证失败`);
    }
    items.push({
      intent: norm.intent,
      intentSig: it.intentSig,
      permitSig: it.permitSig || '0x',
      payer,
    });
  }
  const hashes = items.map((it) => intentHashOf(cfg, it.intent));
  try {
    const r = await settleBatch({ cfg, account: acc, items, ...o });
    return json({ status: r.dryRun ? 'dry-run' : 'executed', intentHashes: hashes, ...r });
  } catch (e) {
    if (e.kind === 'profit') {
      const ok = await Promise.all(
        groupByToken(items, Number(env.MAX_BATCH || 10)).map(async (g) =>
          queue.enqueue(env, queue.queueKey(cfg.idStr, intentHashOf(cfg, g.items[0].intent)), {
            type: 'batch',
            chainId: cfg.idStr,
            items: g.items.map((it) => ({
              intent: stringifyIntent(it.intent),
              intentSig: it.intentSig,
              permitSig: it.permitSig,
              payer: it.payer,
            })),
            intentHashes: g.items.map((it) => intentHashOf(cfg, it.intent)),
            attempts: 0,
            queuedAt: Date.now(),
          }),
        ),
      );
      if (ok.some(Boolean)) return json({ status: 'queued', intentHashes: hashes, reason: e.message }, 202);
    }
    throw e;
  }
}

// cron 重试：重放队列条目（单笔/整批原样），profit 继续等（计次），
// expired/nonce/whitelist/simulate 重试也不会好 → 丢弃并留日志
async function drainQueue(env) {
  if (!queue.hasQueue(env)) return;
  const acc = account(env);
  if (!acc) return;
  const o = opts(env);
  const entries = await queue.drain(env, 32);
  const results = [];
  for (const { key, value } of entries) {
    const cfg = listChains(env).find((c) => c.idStr === String(value.chainId));
    if (!cfg) {
      await queue.drop(env, key);
      results.push({ key, status: 'dropped', reason: `链 ${value.chainId} 已不在配置里` });
      continue;
    }
    const norm = (raw) => {
      const n = normalizeIntent(raw);
      return n.intent ?? null;
    };
    try {
      if (value.type === 'batch') {
        const items = value.items
          .map((it) => ({ ...it, intent: norm(it.intent) }))
          .filter((it) => it.intent);
        if (!items.length) throw new SettleError('shape', '队列条目无法解析');
        await settleBatch({ cfg, account: acc, items, ...o });
      } else {
        const intent = norm(value.intent);
        if (!intent) throw new SettleError('shape', '队列条目无法解析');
        await settleSingle({
          cfg,
          account: acc,
          payer: value.payer,
          intent,
          intentSig: value.intentSig,
          permitSig: value.permitSig || '0x',
          ...o,
        });
      }
      await queue.drop(env, key);
      results.push({ key, status: 'executed' });
    } catch (e) {
      const maxAttempts = Number(env.QUEUE_MAX_ATTEMPTS || 5);
      if (e.kind === 'profit' && (value.attempts ?? 0) < maxAttempts) {
        await queue.enqueue(env, key, { ...value, attempts: (value.attempts ?? 0) + 1 });
        results.push({ key, status: 'requeued', attempts: (value.attempts ?? 0) + 1 });
      } else {
        await queue.drop(env, key);
        results.push({ key, status: 'dropped', reason: e.message });
      }
    }
  }
  if (results.length) console.log('[queue]', JSON.stringify(results));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === '/healthz' && request.method === 'GET') {
      const acc = account(env);
      return json({
        ok: true,
        helper: acc?.address ?? null,
        dryRun: (env.DRY_RUN || 'false') === 'true',
        chains: listChains(env).map((c) => ({ chainId: c.idStr, name: c.meta.name, imputepay: c.imputepay })),
      });
    }

    if (request.method !== 'POST') {
      return json({ error: 'not found', endpoints: ['GET /healthz', 'POST /intents', 'POST /intents/batch'] }, 404);
    }
    // 必配 HELPER_TOKEN：未配 fail-closed，不再默认开放收单口
    if (!env.HELPER_TOKEN) {
      warnIfTokenMissing(env);
      return json({ error: 'helper_token_required', message: 'HELPER_TOKEN 未配置：服务拒绝收单' }, 503);
    }
    if (!checkAuth(env, request)) return json({ error: 'unauthorized' }, 401);
    const limited = checkRateLimit(env, request);
    if (limited) return limited;

    // 请求体上限：先看 content-length（省流早拒），再按真实字节复核（防伪报）
    const maxBody = Number(env.MAX_BODY_BYTES || DEFAULT_MAX_BODY_BYTES);
    if (Number(request.headers.get('content-length') || 0) > maxBody) {
      return json({ error: 'payload_too_large', message: `请求体超过 ${maxBody} 字节上限` }, 413);
    }
    let text;
    try {
      text = await request.text();
    } catch {
      return json({ error: 'shape', message: '读取请求体失败' }, 400);
    }
    if (new TextEncoder().encode(text).byteLength > maxBody) {
      return json({ error: 'payload_too_large', message: `请求体超过 ${maxBody} 字节上限` }, 413);
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return json({ error: 'shape', message: '请求体不是合法 JSON' }, 400);
    }
    try {
      if (url.pathname === '/intents') return await handleSingle(env, body);
      if (url.pathname === '/intents/batch') return await handleBatch(env, body);
      return json({ error: 'not found' }, 404);
    } catch (e) {
      const statusMap = {
        shape: 400,
        verify: 422,
        expired: 422,
        nonce: 409,
        whitelist: 422,
        simulate: 422,
        profit: 422,
        send: 502,
      };
      if (e instanceof SettleError) return json({ error: e.kind, message: e.message }, statusMap[e.kind] ?? 500);
      return json({ error: 'internal', message: e.message.slice(0, 300) }, 500);
    }
  },

  async scheduled(controller, env) {
    await drainQueue(env);
  },
};
