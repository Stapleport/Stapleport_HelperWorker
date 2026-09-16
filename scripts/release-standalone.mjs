// 生成独立可部署的 HelperWorker 发布仓（vendored kits）。
// 用法：node scripts/release-standalone.mjs [outDir]
//   默认 outDir = <仓>/dist/helperworker-standalone
// 产物 = 自足仓：无 monorepo 依赖（pay-kit / worker-kit 源码 vendor 进 src/vendor/），
// 可直接 npm install && npm test && npx wrangler deploy，或 Deploy to Cloudflare 一键部署。
// 首版/变更发布流程：跑本脚本 → 在产物目录 git init/push 到 github.com/Stapleport/HelperWorker。
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = resolve(process.argv[2] ?? join(root, 'dist', 'helperworker-standalone'));

const PAY_KIT = resolve(root, '../Stapleport_Pay_kit');
const WORKER_KIT = resolve(root, '../../worker/Stapleport_WorkerKit');
for (const d of [PAY_KIT, WORKER_KIT]) {
  if (!existsSync(d)) throw new Error(`缺少 kit 源码：${d}（请在 monorepo 内运行本脚本）`);
}

// 重生成时保留 outDir/.git（公布仓的历史不能被发布脚本洗掉）
if (existsSync(outDir)) {
  for (const e of readdirSync(outDir)) {
    if (e === '.git') continue;
    rmSync(join(outDir, e), { recursive: true, force: true });
  }
} else {
  mkdirSync(outDir, { recursive: true });
}
mkdirSync(join(outDir, 'src/vendor'), { recursive: true });

// 1) kit 源码 vendor（pay-kit 仅依赖 viem；worker-kit 零依赖——平移即可）
cpSync(join(PAY_KIT, 'src'), join(outDir, 'src/vendor/pay-kit'), { recursive: true });
cpSync(join(WORKER_KIT, 'src'), join(outDir, 'src/vendor/worker-kit'), { recursive: true });

// 2) 拷贝本仓文件并改写 kit import → vendored 相对路径
const rewriteImports = (srcFile, destFile) => {
  const s = readFileSync(srcFile, 'utf8');
  if (!s.includes('@stapleport/')) return s;
  const rel = relative(dirname(destFile), join(outDir, 'src', 'vendor')).split('\\').join('/');
  return s
    .replace(/(['"])@stapleport\/pay-kit\1/g, `$1${rel}/pay-kit/index.js$1`)
    .replace(/(['"])@stapleport\/worker-kit\1/g, `$1${rel}/worker-kit/index.js$1`);
};
const copyTree = (srcDir, outBase) => {
  mkdirSync(outBase, { recursive: true });
  for (const e of readdirSync(srcDir, { withFileTypes: true })) {
    const s = join(srcDir, e.name);
    const d = join(outBase, e.name);
    if (e.isDirectory()) {
      if (e.name === 'vendor') continue;
      mkdirSync(d, { recursive: true });
      copyTree(s, d);
    } else if (/\.m?js$/.test(e.name)) {
      writeFileSync(d, rewriteImports(s, d));
    } else {
      cpSync(s, d);
    }
  }
};
copyTree(join(root, 'src'), join(outDir, 'src'));
copyTree(join(root, 'test'), join(outDir, 'test'));
for (const f of ['registry.json', 'wrangler.jsonc', 'LICENSE']) cpSync(join(root, f), join(outDir, f));
writeFileSync(join(outDir, '.gitignore'), 'node_modules/\n.dev.vars\n.wrangler/\ndist/\n');
cpSync(join(root, 'templates', '.dev.vars.example'), join(outDir, '.dev.vars.example'));
cpSync(join(root, 'templates', 'README-standalone.md'), join(outDir, 'README.md'));

// 3) standalone package.json：去 file: 依赖，去 sync-registry（registry 已随包内置）
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
delete pkg.dependencies?.['@stapleport/pay-kit'];
delete pkg.dependencies?.['@stapleport/worker-kit'];
delete pkg.scripts?.['sync-registry'];
delete pkg.scripts?.['release:standalone'];
pkg.description = 'Stapleport HelperWorker（独立发布版）：ImputePay 机器支付的第三方 helper——kit 源码已 vendor，无 monorepo 依赖。';
jsonWrite(join(outDir, 'package.json'), pkg);

function jsonWrite(p, obj) {
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

console.log(`standalone 产物 → ${outDir}`);
console.log('后续：cd ' + outDir);
console.log('  npm install && npm test && npx wrangler deploy --dry-run');
console.log('  git init -b main && git add -A && git commit && git remote add origin https://github.com/Stapleport/HelperWorker.git && git push -u origin main');
