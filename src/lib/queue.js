// KV 重试队列：不绑 KV = 纯无状态（暂不可利单直接拒）；绑了 = 202 暂存，cron 周期重估。
// 条目 key 形如 q:<chainId>:<intentHash>；value 为完整可重放 payload（bigint 已字符串化）。
const PREFIX = 'q:';

export const hasQueue = (env) => !!env.INTENT_QUEUE;
export const queueKey = (chainId, intentHash) => `${PREFIX}${chainId}:${intentHash}`;

export async function enqueue(env, key, payload) {
  if (!hasQueue(env)) return false;
  // 24h 兜底过期：intent 本身有 deadline，这里只是防僵尸条目占 KV
  await env.INTENT_QUEUE.put(key, JSON.stringify(payload), { expirationTtl: 86400 });
  return true;
}

export async function drain(env, limit = 32) {
  if (!hasQueue(env)) return [];
  const list = await env.INTENT_QUEUE.list({ prefix: PREFIX, limit });
  const out = [];
  for (const k of list.keys) {
    const raw = await env.INTENT_QUEUE.get(k.name);
    if (raw == null) continue;
    try {
      out.push({ key: k.name, value: JSON.parse(raw) });
    } catch {
      await env.INTENT_QUEUE.delete(k.name); // 坏条目直接丢
    }
  }
  return out;
}

export async function drop(env, key) {
  if (hasQueue(env)) await env.INTENT_QUEUE.delete(key);
}
