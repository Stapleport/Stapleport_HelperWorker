// 运行配置：registry.json（部署事实，构建期随包烘焙）为默认，env 变量逐链覆盖。
// 链启用口径 = CHAIN_IDS 白名单（缺省 = registry 全部链）。
import registry from '../registry.json' with { type: 'json' };

export function chainConfig(env, chainId) {
  const idStr = String(chainId);
  const reg = registry.chains[idStr];
  const rpc = env[`RPC_URL_${idStr}`] || reg?.meta?.rpc;
  const imputepay = env[`IMPUTEPAY_${idStr}`] || reg?.ImputePay;
  if (!rpc || !imputepay) return null;
  return {
    idStr,
    chainId: BigInt(idStr),
    rpc,
    imputepay,
    meta: reg?.meta ?? {},
    tokens: { Test_usdt: reg?.Test_usdt, WBNB: reg?.WBNB },
  };
}

export function listChains(env) {
  const ids = (
    env.CHAIN_IDS || Object.keys(registry.chains).join(',')
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.map((id) => chainConfig(env, id)).filter(Boolean);
}

export const chainNames = (chains) => chains.map((c) => `${c.idStr}(${c.meta.name ?? '?'})`).join(', ');
