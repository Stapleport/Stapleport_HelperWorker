// all.json → registry.json 裁剪核心：helper Worker 专版（与收端/付端 dapp 各持一份同源脚本）。
// Worker 比 dapp 多两样：router 读侧（getAmountsOut/WETH，盈利预检折算用）与代币 permit 读侧。
// 路径基于 import.meta.url 定位，与工作目录无关
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// Worker 不需要 Imputations/LongSystemLog（收端归集体系与它无关）
const TRIM = {
  Test_usdt: ['name', 'version', 'balanceOf', 'decimals', 'symbol', 'allowance', 'nonces'],
  ImputePay: [
    'execute',
    'executeBatch',
    'whitelist',
    'isNonceUsed',
    'intentDigest',
    'DOMAIN_SEPARATOR',
    'INTENT_TYPEHASH',
    'pay_config',
  ],
  PancakeRouter: ['getAmountsOut', 'WETH'],
  WBNB: ['deposit', 'withdraw', 'balanceOf', 'decimals', 'symbol'],
};

const NAMES = ['ImputePay', 'Test_usdt', 'PancakeRouter', 'WBNB'];

export function allJsonPath() {
  return (
    process.env.HARDHAT_ALL_JSON ??
    // 本仓在 Stapleport/web/<板块>/<仓>/scripts 下：向上四级 = Stapleport 总库根
    join(here, '..', '..', '..', '..', 'Stapleport_hardhat', 'deployments', 'all.json')
  );
}

export function syncRegistry({ quiet = false } = {}) {
  const all = JSON.parse(readFileSync(allJsonPath(), 'utf8'));
  const chains = Object.keys(all).filter((k) => /^\d+$/.test(k));
  if (!chains.length) throw new Error('all.json 里没有任何数字 chainId 的链');

  const out = { contracts: {}, chains: {} };
  for (const contract of NAMES) {
    const src = chains.map((c) => all[c]?.[contract]).find(Boolean);
    if (!src) throw new Error(`all.json 的任何链上都找不到 ${contract}`);
    const abi = TRIM[contract]
      ? src.abi.filter((i) => i.type !== 'function' || TRIM[contract].includes(i.name))
      : src.abi;
    out.contracts[contract] = { abi };
  }
  // 该链上部署了 ImputePay 才是付端体系的链（收端链只有 Imputations，本 Worker 用不上）
  for (const chainId of chains) {
    const addresses = Object.fromEntries(
      NAMES.map((n) => [n, all[chainId]?.[n]?.address]).filter(([, a]) => a),
    );
    if (!addresses.ImputePay) {
      if (!quiet) console.warn(`跳过链 ${chainId}：没有 ImputePay 地址`);
      continue;
    }
    const net = Object.values(all[chainId]).find(
      (e) => e && typeof e === 'object' && e.network?.url,
    )?.network;
    if (!net) {
      if (!quiet) console.warn(`跳过链 ${chainId}：部署记录缺 network 元数据`);
      continue;
    }
    out.chains[chainId] = {
      meta: { name: net.name, rpc: net.url, explorer: net.explorer ?? null },
      ...addresses,
    };
  }

  const dest = join(here, '..', 'registry.json');
  writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');
  if (!quiet) {
    console.log(`registry.json → ${dest}`);
    console.log(`chains: ${Object.keys(out.chains).join(', ')}`);
  }
  return dest;
}
