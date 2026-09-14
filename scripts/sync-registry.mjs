// 从 hardhat 项目的 deployments/all.json 抽取 helper Worker 所需注册表 → registry.json
// 用法：npm run sync-registry （或 HARDHAT_ALL_JSON=/path/to/all.json node scripts/sync-registry.mjs）
import { syncRegistry } from './sync-registry-core.mjs';

syncRegistry();
