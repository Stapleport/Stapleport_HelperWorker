// 意图校验 + EIP-712 验签：薄适配（Collect「薄适配留本仓」同款）。
// 正典 2026-09-16 收编进 @stapleport/pay-kit（取代本文件此前的手写实现与 sdk/ TS 重写），
// 规格唯一来源：总库 plans/pay-m1-spec.md。本仓签名/形状留这些别名，worker.js 与测试零改动。
import {
  normalizeIntent,
  recoverPayer,
  intentHash,
  serializeIntent,
  imputePayDomain,
  INTENT_TYPES,
} from '@stapleport/pay-kit';

// 旧名别名：intentHashOf/stringifyIntent 是本仓历史叫法，正典名 intentHash/serializeIntent
export { normalizeIntent, recoverPayer, imputePayDomain, INTENT_TYPES };
export const intentHashOf = (_cfg, intent) => intentHash(intent);
export const stringifyIntent = serializeIntent;
