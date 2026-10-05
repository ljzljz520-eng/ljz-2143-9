'use strict';
/* 时间一律以毫秒 epoch（UTC）存储与计算；展示层再转本地时区字符串 */
const now = () => Date.now();
const iso = (ms) => new Date(ms).toISOString();
const pad = (n) => String(n).padStart(2, '0');
function fmtLocal(ms) {
  if (ms == null) return '—';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const SECOND = 1000, MINUTE = 60 * SECOND;
function hashStr(s) { // 32 位 FNV-1a，用于版本/清单指纹
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h ^ (h >>> 24), 0x01000193); }
  return ('0000000' + (h >>> 0).toString(16)).slice(-8);
}
function jsonOr400(req) {
  try { return JSON.parse(req._body || '{}'); }
  catch { throw Object.assign(new Error('invalid_json'), { status: 400 }); }
}
module.exports = { now, iso, fmtLocal, SECOND, MINUTE, hashStr, jsonOr400 };
