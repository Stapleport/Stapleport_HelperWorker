// all.json → registry.json 裁剪核心：helper Worker 专版。
// 共享骨架正典 = Stapleport_Web_kit/scripts/sync-registry-lib.mjs（syncRegistryCore，
// 2026-09-17 收编；web 三仓的 sync-registry-core.mjs 已改成引它的选项袋薄壳）。本仓是
// worker 侧同源变体——不引 web-kit，保留本地脚本；后续改逻辑需与正典口径对齐维护。
// Worker 比 dapp 多代币 permit 读侧。
// 路径基于 import.meta.url 定位，与工作目录无关
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// Worker 不需要 Imputations/LongSystemLog（收端归集体系与它无关）
// 2026-10-05 hub/mod 切键（P0.2 冻结）：旧 L1 单件 ImputePay 键退役；链门 = pay_hub
// （门面正典代理键，Web_pay 同口径），全量 ABI 面 = IImputePay（聚合接口，地址 = 代理，
// 终身不变——impl 换代 registry 自愈）。
const TRIM = {
  Test_usdt: ['name', 'version', 'balanceOf', 'decimals', 'symbol', 'allowance', 'nonces'],
  SwapRouter: ['getAmountsOut', 'WETH'],
  IImputePay: [
    'execute',
    'executeBatch',
    'fee_bps', // 平台抽成费率视图（报价按净份额口径）
    'whitelist',
    'isNonceUsed',
    'intentDigest',
    'DOMAIN_SEPARATOR',
    'INTENT_TYPEHASH',
    'pay_config',
  ],
};

const NAMES = ['pay_hub', 'IImputePay', 'Test_usdt', 'SwapRouter'];

// 本地链面收窄（2026-10-16 四链定案）：本仓不引 web-kit（见头注），故与 Kit 正典常量
// LOCAL_STEADY_CHAINS 同值本地声明——注册表只收 spoke 31338 + hub 31339 + 外链测试链 31340 +
// SP 测试链 31341；all.json 里 31337/78756 等桶留档不收录。改口径须与 Kit 常量同步维护。
const LOCAL_STEADY_CHAINS = [31338, 31339, 31340, 31341];
// 链显示名（2026-10-16 用户裁定：给用户看的链名 = 语义 + chainId；与 Kit 正典
// CHAIN_DISPLAY_NAMES 同值——本仓不引 web-kit，故本地声明同值常量）。只影响 registry 输出的
// meta.name；all.json 桶键/部署记录 network.name 等内部标识不变。改口径须与 Kit 常量同步维护。
const CHAIN_DISPLAY_NAMES = {
  '31338': '外链主链31338',
  '31339': 'SP主链31339',
  '31340': '外链测试链31340',
  '31341': 'SP测试链31341',
};
const displayName = (chainId, fallback) => CHAIN_DISPLAY_NAMES[String(chainId)] ?? fallback;

export function allJsonPath() {
  return (
    process.env.HARDHAT_ALL_JSON ??
    // 本仓在 Stapleport 总库根直下：scripts 上跳三级 = 总库根
    join(here, '..', '..', '..', 'Stapleport_hardhat', 'deployments', 'all.json')
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
  // 该链上部署了 pay_hub 才是付端体系的链（收端链只有 Imputations，本 Worker 用不上）
  for (const chainId of chains) {
    if (!LOCAL_STEADY_CHAINS.map(String).includes(String(chainId))) {
      if (!quiet) console.warn(`跳过链 ${chainId}：不在 LOCAL_STEADY_CHAINS 白名单（本地链面收窄）`);
      continue;
    }
    const addresses = Object.fromEntries(
      NAMES.map((n) => [n, all[chainId]?.[n]?.address]).filter(([, a]) => a),
    );
    if (!addresses.pay_hub) {
      if (!quiet) console.warn(`跳过链 ${chainId}：没有 pay_hub 地址`);
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
      meta: { name: displayName(chainId, net.name), rpc: net.url, explorer: net.explorer ?? null },
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
