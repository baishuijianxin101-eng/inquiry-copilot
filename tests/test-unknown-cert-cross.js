/* P1-17 第五阶段：未知认证跨句留痕与误报回归（任务书第六节 D1–D4 与回归清单）
   ZZAB / QZ77 为虚构未知认证。纯 Node。运行：node tests/test-unknown-cert-cross.js */
'use strict';
global.window = global;
require('../assets/p0-parse.js');
var P = global.P0Parse;
var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}
function unrec(text) { return P.extract(text).fields.unrecognizedCertMentions; }
function has(text, token) { return unrec(text).some(function (u) { return u.token.toUpperCase() === token; }); }
function get(text, token) { return unrec(text).filter(function (u) { return u.token.toUpperCase() === token; })[0] || null; }

/* D1 型：相邻句补充的未知认证（carry：前句触发 + 本句 need 动词） */
var d1 = 'Our project requires CE. We also need ZZAB for the site.';
var u1 = get(d1, 'ZZAB');
ok('D1. 跨句补充的未知认证不丢失', !!u1, JSON.stringify(unrec(d1)));
ok('D1. 留痕带原文片段与依据 via=carry', !!u1 && /ZZAB/.test(u1.snippet) && u1.via === 'carry', JSON.stringify(u1));

/* D3 型：与已识别认证同句并列（co-cert） */
var d3 = 'We need a pressure sensor. It must support ATEX and QZ77.';
var u3 = get(d3, 'QZ77');
ok('D3. 与已知认证同现的未知认证被留痕', !!u3 && u3.via === 'co-cert', JSON.stringify(unrec(d3)));

/* 本句自带触发词（trigger，第四阶段既有行为保持） */
var uT = get('ZZAB certification is required.', 'ZZAB');
ok('T1. 本句触发词留痕 via=trigger', !!uT && uT.via === 'trigger', JSON.stringify(uT));

/* D4 型：无任何认证上下文的技术句不扫描 */
ok('D4. 型号句不产生未知认证', unrec('The product has a 4-20mA output. The model is PS-900.').length === 0,
  JSON.stringify(unrec('The product has a 4-20mA output. The model is PS-900.')));

/* 回归清单：已登记认证（CERTS 表内）不得进未知列表 */
['We require ATEX certification.', 'We require CE certification.', 'FCC certification is required.'].forEach(function (t, i) {
  ok('K' + (i + 1) + '. 已登记认证不进未知列表：' + t, unrec(t).length === 0, JSON.stringify(unrec(t)));
});
/* 回归清单：IECEx / ISO13485 不在 CERTS 登记表内——既有设计（第三阶段）是进未知留痕并要求核实，
   不得因本轮扫描扩展而被静默丢失，也不得重复计入 */
ok('K4. IECEx 按既有设计留痕一次（未登记认证）',
  unrec('We require IECEx certification.').filter(function (u) { return u.token === 'IECEx'; }).length === 1,
  JSON.stringify(unrec('We require IECEx certification.')));
ok('K5. ISO13485 按既有设计留痕一次（ISO 本体已登记，带号标准留痕）',
  unrec('ISO 13485 certification is required.').filter(function (u) { return u.token === 'ISO13485'; }).length === 1,
  JSON.stringify(unrec('ISO 13485 certification is required.')));
/* 回归清单：商品属性 / 参数不得误报（含与认证句相邻的情形） */
ok('F1. ELRS receiver 不误报（即使相邻句有认证要求）',
  !has('The receiver uses ELRS. We require CE certification for the gateway.', 'ELRS'), '');
ok('F2. WiFi6 / Mbps 不误报',
  unrec('The gateway supports WiFi6 and 100 Mbps. We require CE certification.').length === 0,
  JSON.stringify(unrec('The gateway supports WiFi6 and 100 Mbps. We require CE certification.')));
ok('F3. PS-900 型号不误报（与认证句相邻）',
  !has('We require CE certification. The model is PS-900.', 'PS-900'), '');
/* 已知边界（记录而非缺陷）：字母+数字型虚构编码会被型号提取优先归为型号，不进未知认证 */
var f4 = P.extract('Our project requires CE. We also need ZZQ9 for the site.').fields;
ok('F4. 型号型编码 ZZQ9 归入 models（已知边界，原文信息不丢失）',
  f4.models.indexOf('ZZQ9') >= 0 && !has('Our project requires CE. We also need ZZQ9 for the site.', 'ZZQ9'),
  JSON.stringify(f4.models));
console.log('== unknown-cert-cross: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
