/* P1-23-R6 身份映射层（独立模块，不改动既有业务模块）
 *
 * 职责：内部稳定 ID 与外部身份四元组 (source_system, source_account,
 * entity_type, external_id_raw) 的映射、重复导入幂等判定、版本顺序判定、
 * 冲突登记与人工处理、员工确认值保护（四层值模型）。
 *
 * 原则：
 * - 内部 ID 由本模块独立生成，永不由外部 ID 清洗/截断派生（不使用 safeId）；
 * - external_id_raw 原样保存与比较（区分大小写，不做字符删除）；
 * - 内容哈希仅用于识别内容变化，不替代身份；哈希算法与规范化版本均有记录；
 * - 同步/导入只写来源值与解析值，永不写员工确认值；
 * - 冲突永不静默跳过，一律登记并可人工处理，同一事件重放不重复建冲突。
 *
 * 本模块当前为独立层：尚未接入既有导入入口（见 R6 INTEGRATION-GAPS）。
 * 浏览器以 window.Identity 暴露；Node 下 module.exports 供专项测试。 */
(function () {
  'use strict';

  /* R6 第四项：当前规范化版本升至 canon-v3（长度前缀编码，见
     canonicalize）。v1/v2 的规则与哈希语义保持不动——旧注册表按
     其自带 canonVersion 继续校验，实体在 importRecord 的既有规范
     升级路径中逐个重算并标注 canon_upgraded，不静默改变旧哈希。
     注意：内容哈希只是变更检测指纹（FNV 非密码学哈希），不是
     防篡改签名，不得作为完整性证明使用。 */
  var CANON_VERSION = 'canon-v3';
  var HASH_ALGO = 'fnv1a32x2';

  /* 各实体类型参与内容哈希的业务字段与规范化规则。
     规则按字段定义：trim（是否去首尾空白）；默认大小写敏感、数值按数值规范化。
     不参与哈希：本地时间、内部 ID、展示状态等本地字段（根本不列入清单）。 */
  var FIELD_SPECS = {
    opportunity: [
      { name: 'buyerName', trim: true }, { name: 'buyerCompany', trim: true },
      { name: 'productText', trim: true }, { name: 'qty', type: 'number' }, { name: 'unit', trim: true },
      { name: 'destination', trim: true }, { name: 'rawTextHash' }
    ],
    product: [
      { name: 'title', trim: true }, { name: 'model', trim: true }, { name: 'category', trim: true }
    ],
    order: [
      { name: 'buyerName', trim: true }, { name: 'amountCents', type: 'number' }, { name: 'currency', trim: true },
      { name: 'statusText', trim: true }
    ],
    buyer: [{ name: 'displayName', trim: true }, { name: 'company', trim: true }]
  };
  /* R7 第一项：字段允许类型由 FIELD_SPECS.type 声明（缺省 'string'，
     仅 qty / amountCents 为 'number'）。canon-v3 对未声明类型一律
     拒绝（见 canonicalize），不允许布尔/对象/数组等未经定义的类型
     经 String() 静默进入哈希——那会让 true 与 'true'、对象与
     '[object Object]'、数组与其 join 字符串发生编码碰撞。 */

  var MISSING = '\u0000MISSING\u0000';

  /* R7 第一项：canon-v3 类型拒绝错误（带 code，供调用方区分）。
     R8 第三项：非有限数值（NaN/Infinity/-Infinity）的 typeof 同样是
     'number'，错误标签直接用其字符串形式标明，便于定位。 */
  function canonTypeError(field, v) {
    var tag = Array.isArray(v) ? 'array' : (typeof v === 'number' && !isFinite(v)) ? String(v) : typeof v;
    var e = new Error('canon_type_invalid:' + field + ':' + tag);
    e.code = 'canon_type_invalid';
    return e;
  }

  function canonicalize(content, entityType, canonVersion) {
    var version = canonVersion || CANON_VERSION;
    var spec = FIELD_SPECS[entityType] || [];
    if (version === 'canon-v3') {
      /* canon-v3：长度前缀编码。每字段编码为 name=tag:len:value
         （数值 tag=n 且 len 为其字符串长度；字符串 tag=s；缺失
         tag=M；null tag=Z），字段边界由长度唯一确定——值内含
         '|'、'='、换行、NUL 等任意字符都不可能伪造出另一个字段
         的边界，编码单射。trim 规则与 v1 一致（按字段定义）。
         R7 第一项：类型按 FIELD_SPECS.type 严格校验——数值字段
         只接受 number、字符串字段只接受 string；布尔/对象/数组/
         函数等未声明类型抛 canon_type_invalid 明确拒绝，绝不
         String() 后静默入哈希（防 true/'true' 等跨类型碰撞）。
         缺失（M）、null（Z）、空串（s:0:）继续严格区分。 */
      var parts3 = spec.map(function (f) {
        var v = content ? content[f.name] : undefined;
        if (v === undefined) return f.name + '=M';
        if (v === null) return f.name + '=Z';
        if ((f.type || 'string') === 'number') {
          /* R8 第三项：数值字段必须是有限数。NaN/Infinity/-Infinity
             的 typeof 也是 'number'，旧实现会把它们 String() 后入哈希
             （且经 JSON 落盘后会变成 null，哈希随之漂移）。现明确以
             canon_type_invalid 拒绝，绝不静默转换。-0 与 0 不区分：
             String(-0) === '0'，且 JSON 往返同样把 -0 归一为 0，
             区分二者反而会造成落盘前后哈希不一致；业务量（数量、
             金额）中 -0 也没有独立含义。v1/v2 分支不在此列，历史
             语义保持不变。 */
          if (typeof v !== 'number' || !isFinite(v)) throw canonTypeError(f.name, v);
          var ns = String(v); return f.name + '=n:' + ns.length + ':' + ns;
        }
        if (typeof v !== 'string') throw canonTypeError(f.name, v);
        var s = f.trim ? v.trim() : v;
        return f.name + '=s:' + s.length + ':' + s;
      });
      return 'canon-v3|' + parts3.join('|');
    }
    var parts = spec.map(function (f) {
      var v = content ? content[f.name] : undefined;
      if (v === undefined) return f.name + '=' + MISSING;      /* 缺失与显式 null 严格区分 */
      if (v === null) return f.name + '=null';
      if (typeof v === 'number') return f.name + '=n:' + String(v);
      var s = String(v);
      if (f.trim) s = s.trim();
      if (canonVersion === 'canon-v2' && f.name === 'rawTextHash') s = s.trim(); /* v2 规则示例：见测试 21 */
      return f.name + '=s:' + s;
    });
    return version + '|' + parts.join('|');
  }

  function fnv(str, seed) {
    var h = seed >>> 0;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16);
  }
  function contentHash(content, entityType, canonVersion) {
    var c = canonicalize(content, entityType, canonVersion);
    return HASH_ALGO + ':' + fnv(c, 2166136261) + fnv(c, 42424242);
  }

  /* R4 第二项：身份键编码 esc-v2。旧版直接以 '|' 拼接四元组，字段内含 '|'
     时不同身份可拼出同一键（如 (a|b, c) 与 (a, b|c)）。新编码先转义每个
     字段内的 '\\' 与 '|'，再以 '|' 连接——转义后字段内不存在未转义的 '|'，
     编码单射、无歧义。字段不含 '\\' 与 '|' 时编码结果与旧版逐字相同，
     因此全部存量正常键无需改写；仅含特殊字符的历史键在 importState
     迁移时按四元组（实体内保存的 identity/additionalIdentities）重算。 */
  var KEY_ENCODING = 'esc-v2';
  function escapeKeyField(v) { return String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/\|/g, '\\|'); }
  function identityKeyOf(idn) {
    return escapeKeyField(idn.source_system) + '|' + escapeKeyField(idn.source_account) + '|' + escapeKeyField(idn.entity_type) + '|' + escapeKeyField(idn.external_id_raw);
  }
  /* 旧版裸拼接键，仅供 importState 迁移校验比对，不得用于新写入。 */
  function legacyKeyOf(idn) {
    return idn.source_system + '|' + idn.source_account + '|' + idn.entity_type + '|' + idn.external_id_raw;
  }
  /* 一个实体在注册表中的全部合法键：主身份 + additionalIdentities。
     R8-R4-R1-R2：附加数组改下标迭代——不再调用数组自身的 forEach。
     结构指纹可接受「假 Array.prototype」数组（R8-R4-R1-R1 的 B04），
     这类数组没有 forEach 方法，旧实现在此抛 TypeError 逃逸；下标
     读取只依赖数组的内部槽（length/元素），不依赖原型方法。元素
     读取仍是普通属性读：调用方（registerExisting）已先经
     entityShapeOk 描述符校验保证元素为数据属性；importState 的
     输入来自 JSON.parse（无 getter）。非数组的 additionalIdentities
     按空处理，与旧 (… || []) 语义一致。 */
  function entityKeys(entity, keyOf) {
    var keys = [];
    if (entity && entity.identity) keys.push(keyOf(entity.identity));
    var adds = entity && entity.additionalIdentities;
    if (Array.isArray(adds)) {
      for (var i = 0; i < adds.length; i++) keys.push(keyOf(adds[i]));
    }
    return keys;
  }

  /* 身份完整性：来源系统/实体类型/原始外部 ID 缺失 → 不建正式映射；
     来源账号缺失 → 不跨账号猜测，进待复核（不建正式映射）。 */
  function validateIdentity(idn) {
    if (!idn || typeof idn !== 'object') return { ok: false, missing: ['identity'] };
    var missing = [];
    /* R5 6.2：四个身份字段必须是字符串。数字/对象/数组/布尔等非字符串
       一律按缺失处理，绝不经 String() 隐式转换进入身份键——否则数字
       123 与字符串 '123' 会拼成同一个键，造成不同身份静默碰撞。
       合法：非空字符串（含空格、Unicode、超长，均原样保留不截断）；
       拒绝：缺失/null/非字符串/空字符串；账号为非字符串或缺失时
       与既有语义一致，进人工复核（needsReview），不跨账号猜测。 */
    if (typeof idn.source_system !== 'string' || !idn.source_system) missing.push('source_system');
    if (typeof idn.entity_type !== 'string' || !idn.entity_type) missing.push('entity_type');
    if (typeof idn.external_id_raw !== 'string' || idn.external_id_raw === '') missing.push('external_id_raw');
    if (missing.length) return { ok: false, missing: missing };
    if (typeof idn.source_account !== 'string' || !idn.source_account) return { ok: false, missing: ['source_account'], needsReview: true };
    return { ok: true };
  }

  var seq = 0;
  function newInternalId(entityType, rng) {
    seq += 1;
    var rand = Math.floor((rng ? rng() : Math.random()) * 4294967296).toString(36);
    return 'int_' + entityType + '_' + Date.now().toString(36) + rand + seq.toString(36);
  }
  var conflictSeq = 0;
  function newConflictId() { conflictSeq += 1; return 'cf_' + Date.now().toString(36) + '_' + conflictSeq; }

  function createRegistry() {
    /* R5 6.1：映射表用无原型对象。内部 ID 与身份键来自外部数据，
       '__proto__'/'constructor' 等键在普通对象上赋值会改写原型或被
       原型链遮蔽，造成映射静默丢失/污染；无原型对象无此问题，
       JSON 序列化与 Object.keys 行为不变。 */
    return { byKey: Object.create(null), byInternal: Object.create(null), conflicts: [], reviewEvents: [], canonVersion: CANON_VERSION, keyVersion: KEY_ENCODING };
  }

  function findConflict(reg, fingerprint) {
    for (var i = 0; i < reg.conflicts.length; i++) if (reg.conflicts[i].fingerprint === fingerprint) return reg.conflicts[i];
    return null;
  }
  function addConflict(reg, kind, idn, internalId, summary, fingerprint) {
    if (fingerprint && findConflict(reg, fingerprint)) return findConflict(reg, fingerprint); /* 同一事件重放不重复建 */
    var c = { id: newConflictId(), kind: kind, identity: idn ? { source_system: idn.source_system, source_account: idn.source_account, entity_type: idn.entity_type, external_id_raw: idn.external_id_raw } : null,
      internalId: internalId || null, summary: String(summary || ''), at: new Date().toISOString(),
      status: 'PENDING', resolution: null, resolvedBy: null, resolvedAt: null, fingerprint: fingerprint || null };
    reg.conflicts.push(c);
    return c;
  }

  /* 四层值：sourceValue（来源原始）/ parsedValue（系统解析）/ confirmedValue（员工确认）
     展示值 = confirmed ?? parsed ?? source（按字段合并）。 */
  function displayValue(entity) {
    var out = {}, layers = [entity.sourceValue || {}, entity.parsedValue || {}, (entity.confirmedValue && entity.confirmedValue.fields) || {}];
    layers.forEach(function (l) { Object.keys(l).forEach(function (k) { out[k] = l[k]; }); });
    return out;
  }

  function setConfirmation(reg, internalId, fields, operator, basedOnHash) {
    var e = reg.byInternal[internalId];
    if (!e) return { ok: false, reason: 'entity_not_found' };
    e.confirmedValue = { fields: fields, by: operator, at: new Date().toISOString(), basedOnHash: basedOnHash || e.contentHash };
    return { ok: true };
  }
  function revokeConfirmation(reg, internalId, operator) {
    var e = reg.byInternal[internalId];
    if (!e || !e.confirmedValue) return { ok: false, reason: 'no_confirmation' };
    e.confirmationHistory = e.confirmationHistory || [];
    e.confirmationHistory.push({ revoked: e.confirmedValue, by: operator, at: new Date().toISOString() });
    e.confirmedValue = null;
    return { ok: true };
  }

  /* 导入/同步一条外部记录。evt: { identity, content, sourceVersion?, sourceUpdatedAt? }。
     返回 { status, internalId, conflictId?, confirmationReview? }。 */
  function importRecord(reg, evt) {
    var idn = evt && evt.identity;
    var v = validateIdentity(idn);
    if (!v.ok) {
      if (v.needsReview) { var c0 = addConflict(reg, 'missing_account', idn, null, '来源账号缺失，未建正式映射', 'missing_account|' + (idn.source_system || '') + '|' + (idn.entity_type || '') + '|' + (idn.external_id_raw || '')); return { status: 'NEEDS_REVIEW', conflictId: c0.id }; }
      return { status: 'INVALID', missing: v.missing };
    }
    var key = identityKeyOf(idn);
    var hash = contentHash(evt.content || {}, idn.entity_type, reg.canonVersion);
    var existing = reg.byKey[key];
    if (!existing) {
      /* R4 第五项：内部 ID 生成后必须查重。seq 单调递增使同进程内碰撞
         几乎不可能，但注册表可能由外部导入/合并而来——生成值若已被
         占用则重新生成，多次仍冲突则明确抛错使整批导入失败，
         绝不覆盖既有实体、绝不把重复 ID 静默当作同一实体。 */
      var internalId = null;
      for (var attempt = 0; attempt < 50; attempt++) {
        var candidate = newInternalId(idn.entity_type);
        if (!reg.byInternal[candidate]) { internalId = candidate; break; }
      }
      if (!internalId) throw new Error('internal_id_generation_failed');
      var entity = { internalId: internalId, identity: { source_system: idn.source_system, source_account: idn.source_account, entity_type: idn.entity_type, external_id_raw: idn.external_id_raw },
        content: evt.content || {}, contentHash: hash, canonVersion: reg.canonVersion,
        sourceVersion: evt.sourceVersion != null ? evt.sourceVersion : null,
        sourceUpdatedAt: evt.sourceUpdatedAt || null,
        sourceValue: evt.content || {}, parsedValue: null, confirmedValue: null, archived: false };
      reg.byKey[key] = entity; reg.byInternal[internalId] = entity;
      return { status: 'CREATED', internalId: internalId };
    }
    /* 规范化版本升级：内容在新规范下等价 → 视为未变化，仅刷新哈希记录 */
    if (existing.canonVersion !== reg.canonVersion) {
      var reHash = contentHash(existing.content, idn.entity_type, reg.canonVersion);
      var newHashSameContent = contentHash(evt.content || {}, idn.entity_type, reg.canonVersion);
      if (canonicalize(existing.content, idn.entity_type, reg.canonVersion) === canonicalize(evt.content || {}, idn.entity_type, reg.canonVersion)) {
        existing.contentHash = reHash; existing.canonVersion = reg.canonVersion;
        return { status: 'UNCHANGED', internalId: existing.internalId, note: 'canon_upgraded' };
      }
      hash = newHashSameContent;
    }
    var order = compareOrder(existing, evt);
    if (order === 'stale') return { status: 'STALE', internalId: existing.internalId };
    if (order === 'same') {
      if (hash === existing.contentHash) return { status: 'UNCHANGED', internalId: existing.internalId };
      var fp1 = key + '|same_version_diff_content|' + (evt.sourceVersion != null ? evt.sourceVersion : evt.sourceUpdatedAt || '') + '|' + hash;
      var c1 = addConflict(reg, 'same_version_different_content', idn, existing.internalId, '同版本内容不一致', fp1);
      return { status: 'CONFLICT', internalId: existing.internalId, conflictId: c1.id };
    }
    if (order === 'unknown') {
      if (hash === existing.contentHash) return { status: 'UNCHANGED', internalId: existing.internalId };
      var fp2 = key + '|order_unknown|' + hash;
      var c2 = addConflict(reg, 'order_unknown', idn, existing.internalId, '无可靠版本依据，内容不同，需人工判断', fp2);
      return { status: 'NEEDS_REVIEW', internalId: existing.internalId, conflictId: c2.id };
    }
    /* order === 'newer'：更新来源值与解析值，永不写确认值 */
    var basisChanged = !!(existing.confirmedValue && existing.confirmedValue.basedOnHash !== hash);
    existing.content = evt.content || {}; existing.contentHash = hash;
    existing.sourceValue = evt.content || {};
    if (evt.sourceVersion != null) existing.sourceVersion = evt.sourceVersion;
    if (evt.sourceUpdatedAt) existing.sourceUpdatedAt = evt.sourceUpdatedAt;
    if (basisChanged) reg.reviewEvents.push({ internalId: existing.internalId, kind: 'confirmation_basis_changed', at: new Date().toISOString() });
    return { status: 'UPDATED', internalId: existing.internalId, confirmationReview: basisChanged };
  }

  /* R4 第六项：来源版本比较规则（明确定义，不再用 JS 裸 < > 混合比较）。
     支持的版本形态与比较方式：
       - number（有限数）：数值比较；
       - 数字字符串（整数或小数，如 "2"、"1.5"）：按数值比较（整数走
         BigInt 避免精度丢失）；number 与数字字符串同属数值类，可互比；
       - 语义版本 "x.y.z"（三段纯数字）：逐段数值比较；
       - 其余字符串：仅当两侧逐字相同才判 same，不同则 unknown——
         绝不使用字典序猜测先后。
     不支持/混合形态（数值 vs 语义版本、布尔、对象等）一律 unknown，
     由 importRecord 走 NEEDS_REVIEW/冲突通道，绝不自动覆盖。
     优先级：两侧都有 sourceVersion 时只以版本定序（版本不可比 → unknown，
     不再回退时间戳，因为来源既已版本化，时间戳口径不可靠）；
     任一侧缺版本时才比较 sourceUpdatedAt；再缺则 unknown。 */
  function versionClass(v) {
    if (typeof v === 'number') return isFinite(v) ? 'numeric' : 'invalid';
    if (typeof v === 'string') {
      if (/^[+-]?\d+$/.test(v) || /^[+-]?\d*\.\d+$/.test(v)) return 'numeric';
      if (/^\d+\.\d+\.\d+$/.test(v)) return 'semver';
      return 'string';
    }
    return 'invalid';
  }
  function numericCmp(a, b) {
    var sa = String(a), sb = String(b);
    if (/^[+-]?\d+$/.test(sa) && /^[+-]?\d+$/.test(sb)) {
      var ba = BigInt(sa), bb = BigInt(sb);
      return ba < bb ? -1 : (ba > bb ? 1 : 0);
    }
    var na = Number(a), nb = Number(b);
    if (isNaN(na) || isNaN(nb)) return null;
    return na < nb ? -1 : (na > nb ? 1 : 0);
  }
  function versionOrder(evtV, curV) {
    var ca = versionClass(evtV), cb = versionClass(curV);
    if (ca === 'invalid' || cb === 'invalid') return 'unknown';
    if (ca !== cb) {
      /* 数值类内 number 与数字字符串可互比；其余跨类不可比 */
      if (!(ca === 'numeric' && cb === 'numeric')) return 'unknown';
    }
    if (ca === 'numeric') {
      var c = numericCmp(evtV, curV);
      if (c === null) return 'unknown';
      return c < 0 ? 'stale' : (c > 0 ? 'newer' : 'same');
    }
    if (ca === 'semver') {
      var pa = String(evtV).split('.'), pb = String(curV).split('.');
      for (var i = 0; i < 3; i++) {
        var da = parseInt(pa[i], 10), db = parseInt(pb[i], 10);
        if (da !== db) return da < db ? 'stale' : 'newer';
      }
      return 'same';
    }
    /* 普通字符串：只认逐字相同 */
    return String(evtV) === String(curV) ? 'same' : 'unknown';
  }
  function compareOrder(existing, evt) {
    if (evt.sourceVersion != null && existing.sourceVersion != null) {
      return versionOrder(evt.sourceVersion, existing.sourceVersion);
    }
    if (evt.sourceUpdatedAt && existing.sourceUpdatedAt) {
      var a = Date.parse(evt.sourceUpdatedAt), b = Date.parse(existing.sourceUpdatedAt);
      if (!isNaN(a) && !isNaN(b)) { if (a < b) return 'stale'; if (a > b) return 'newer'; return 'same'; }
    }
    return 'unknown';
  }

  /* 把一个已有内部实体绑定到另一个外部身份（人工合并通道）：
     同来源+同账号+同类型的第二个不同原始 ID → 强制登记冲突待人工确认，不自动合并。 */
  function bindAdditionalIdentity(reg, internalId, idn, operator) {
    var e = reg.byInternal[internalId];
    if (!e) return { status: 'INVALID', reason: 'entity_not_found' };
    var v = validateIdentity(idn);
    if (!v.ok) return { status: 'INVALID', missing: v.missing };
    var key = identityKeyOf(idn);
    /* R8-R4-R1-R3-R1 第一项：双索引对象一致性。旧实现只比较
       internalId 字符串：byKey 与 byInternal 指向两个不同对象、仅
       internalId 相同（双索引分裂）时会被误判 UNCHANGED 静默放行。
       现按对象引用判定，并与 registerExisting 的处理口径对齐：
       - keyHit === e（同一规范对象）→ 原幂等 UNCHANGED；
       - keyHit 为另一对象 → 先 entityShapeOk 无 getter 结构校验，
         非法 → 登记 index_entity_invalid 冲突并拒绝（不读其字段）；
       - 结构合法且 internalId 不同 → 原 duplicate_internal；
       - 结构合法、internalId 相同但对象不同 → 登记
         index_split_conflict 并拒绝；bind 通道不自动合并/统一。 */
    var keyHit = reg.byKey[key];
    if (keyHit) {
      /* R5 6.3：幂等——该身份已映射到本实体（主身份或已绑定的附加
         身份）时，重复绑定返回 UNCHANGED：不重复追加
         additionalIdentities、不重复建映射、不触碰其他实体的映射。
         R3-R1 起以对象引用为准（见上）。 */
      if (keyHit === e) return { status: 'UNCHANGED', internalId: internalId };
      if (!entityShapeOk(keyHit)) {
        var cE = addConflict(reg, 'index_entity_invalid', idn, internalId, 'byKey 命中的实体结构损坏（字段访问器化/主身份/附加身份不合法），拒绝绑定', key + '|index_entity_invalid|bind|' + internalId);
        return { status: 'CONFLICT', conflictId: cE.id };
      }
      if (keyHit.internalId !== internalId) {
        var c = addConflict(reg, 'duplicate_internal', idn, internalId, '该外部身份已映射到另一内部实体', key + '|duplicate_internal');
        return { status: 'CONFLICT', conflictId: c.id };
      }
      var cS = addConflict(reg, 'index_split_conflict', idn, internalId, '同一身份的 byKey/byInternal 指向两个不同实体对象（双索引分裂），拒绝静默放行与自动合并', key + '|index_split|bind|' + internalId);
      return { status: 'CONFLICT', conflictId: cS.id };
    }
    if (e.identity.source_system === idn.source_system && e.identity.source_account === idn.source_account && e.identity.entity_type === idn.entity_type && e.identity.external_id_raw !== idn.external_id_raw) {
      var c2 = addConflict(reg, 'conflicting_identity_for_entity', idn, internalId, '同一来源账号下两个不同原始 ID 指向同一实体，需人工确认', key + '|conflicting|' + internalId);
      return { status: 'CONFLICT', conflictId: c2.id };
    }
    /* R8-R4-R1-R3：绑定写入边界。旧实现 `e.additionalIdentities || []`
       只挡 falsy：truthy 普通对象/字符串会被下标赋值塞进 'undefined'
       属性仍报 BOUND（问题 A）；普通赋值 `arr[arr.length] = x` 又会被
       原型链上的继承 setter 截获——setter 执行、元素未落位、仍报
       BOUND 并写 byKey（问题 B）。现改为全程防守：
       - 字段经 getOwnPropertyDescriptor 读取：访问器/不可枚举 →
         INVALID，全程零 getter；
       - 字段确实缺失（或值为 undefined，与缺失同义）才初始化，且用
         Object.defineProperty 在 e 自身定义数据属性（绕过 e 的继承
         setter），失败 → INVALID，不写 byKey；
       - 已存在的值必须是数组且通过结构校验（arrayProtoOk 指纹、
         无 Symbol、稠密无附加属性、每个元素为可枚举数据属性）；
       - 追加前预检可扩展性与 length 可写性、目标索引位未被占用；
       - 追加用 Object.defineProperty 在数组自身定义索引数据属性
         （[[DefineOwnProperty]] 不触发任何 setter、不调用数组自身
         方法），写后按描述符复核落位与 length，全部通过才写 byKey。
       任一步失败都返回 INVALID 且不修改实体与索引（校验全在写入
       之前；defineProperty 对冻结/不可扩展数组在修改前即抛错）。 */
    /* R8-R4-R1-R3-R1-R1：写入原子性——两阶段提交（在 R3 校验之上）。
       旧流程是「就地初始化/追加 → 普通赋值写 byKey」：byKey 若冻结、
       不可扩展、目标键被占或原型有 setter，赋值或抛错逃逸、或被
       setter 吞掉，实体侧却已经改完，形成部分写入。现改为：
       阶段一（零修改预检）：R3 的全部描述符校验照旧，并新增 byKey
       预检（目标键无自有属性、映射表可扩展）与初始化情形的实体
       可扩展预检；字段缺失时待写入数组先在实体之外备好（含新身份
       的完整数组），不在实体上提前留空数组。
       阶段二（提交）：先实体一步（初始化 = 一次 defineProperty
       落入备好数组；既存数组 = 一次 defineProperty 追加），复核后
       再用 defineProperty 写 byKey（不触发原型 setter），写后按
       描述符复核 byKey[key] === e。byKey 写入抛错或复核不通过 →
       回滚实体一步（初始化情形 delete 自有字段；既存数组以
       defineProperty 把 length 截回原值，元素随之移除）并返回
       INVALID(registry_write_failed)。回滚手段均为
       defineProperty/delete，不经 [[Set]]、不触发任何 setter；
       对普通对象（createRegistry/importState 产物）回滚必成，
       因为被回滚的属性都是本函数刚以 configurable:true 定义的、
       length 可写已在预检中确认。Proxy 注册表/实体不在此保证内
       （trap 可在抛错前任意变更状态，不可证明，沿袭边界声明）。 */
    var newIdentity = { source_system: idn.source_system, source_account: idn.source_account, entity_type: idn.entity_type, external_id_raw: idn.external_id_raw, boundBy: operator || null, at: new Date().toISOString() };
    var dAdds = Object.getOwnPropertyDescriptor(e, 'additionalIdentities');
    if (dAdds && (!('value' in dAdds) || !dAdds.enumerable)) return { status: 'INVALID', reason: 'additional_identities_invalid' };
    /* R8-R4-R1-R3-R1-R2 第一项：精确区分三态——属性不存在
       （addsAbsent）／属性存在但值为 undefined／属性存在且为数组。
       R1-R1 把前两态合并、回滚一律 delete，会把原本存在的
       undefined 属性连同其原始描述符一起抹掉。现保存原始描述符
       dAdds 于提交前，回滚时：原本不存在才 delete；原本存在且为
       undefined 时用 defineProperty 按原始描述符逐字段恢复
       （不删除、不经 [[Set]]、不触发继承 setter）。 */
    var addsAbsent = !dAdds;
    var needInit = addsAbsent || dAdds.value === undefined;
    var adds = null, oldLength = 0, targetIdx = null;
    if (needInit) {
      if (!Object.isExtensible(e)) return { status: 'INVALID', reason: 'additional_identities_not_writable' };
    } else {
      adds = dAdds.value;
      if (!Array.isArray(adds)) return { status: 'INVALID', reason: 'additional_identities_invalid' };
      if (!arrayProtoOk(adds)) return { status: 'INVALID', reason: 'additional_identities_invalid' };
      if (Object.getOwnPropertySymbols(adds).length > 0) return { status: 'INVALID', reason: 'additional_identities_invalid' };
      if (Object.getOwnPropertyNames(adds).length !== adds.length + 1) return { status: 'INVALID', reason: 'additional_identities_invalid' };
      for (var ci = 0; ci < adds.length; ci++) {
        var dEl = Object.getOwnPropertyDescriptor(adds, String(ci));
        if (!dEl || !('value' in dEl) || !dEl.enumerable) return { status: 'INVALID', reason: 'additional_identities_invalid' };
      }
      if (!Object.isExtensible(adds)) return { status: 'INVALID', reason: 'additional_identities_not_writable' };
      var dLen = Object.getOwnPropertyDescriptor(adds, 'length');
      if (!dLen || !('value' in dLen) || !dLen.writable) return { status: 'INVALID', reason: 'additional_identities_not_writable' };
      oldLength = adds.length;
      targetIdx = String(oldLength);
      if (Object.getOwnPropertyDescriptor(adds, targetIdx)) return { status: 'INVALID', reason: 'additional_identities_invalid' };
    }
    if (Object.getOwnPropertyDescriptor(reg.byKey, key)) return { status: 'INVALID', reason: 'registry_key_occupied' };
    if (!Object.isExtensible(reg.byKey)) return { status: 'INVALID', reason: 'registry_not_writable' };
    /* R8 收尾审计：回滚必须可验证。旧 rollbackEntityStep 吞掉回滚
       异常且不复核恢复结果——恢复失败与成功返回同样的普通
       INVALID，残留副作用无从知晓。现改为：回滚动作后以
       verifyRestored() 按原始状态逐项复核（不存在态：无自有
       属性；undefined 态：描述符四字段与 dAdds 全等；数组态：
       length 复原且目标索引位无自有属性）；提交 defineProperty
       抛错的路径同样先复核「抛错即无变更」是否属实。复核通过
       才返回普通 INVALID；不通过返回 reason:'rollback_failed'
       + rollbackFailed:true + failedAt（失败发生在哪一步的原
       reason）+ residual（残留状态描述），不假装无副作用。
       边界仍为本函数的输入契约（普通对象/普通数组）：契约内
       回滚必成——被回滚的属性都是本函数刚以 configurable:true
       定义的、数组 length 可写已在预检中确认——复核是把
       「必成」变成「已验证」；契约外对象（含 Proxy）不在原子性
       保证内，但其导致的恢复失败会被如实报告而非掩盖。 */
    function verifyRestored() {
      if (needInit) {
        var dNow = Object.getOwnPropertyDescriptor(e, 'additionalIdentities');
        if (addsAbsent) return !dNow;
        return !!dNow && ('value' in dNow) && dNow.value === dAdds.value && dNow.writable === dAdds.writable && dNow.enumerable === dAdds.enumerable && dNow.configurable === dAdds.configurable;
      }
      return adds.length === oldLength && !Object.getOwnPropertyDescriptor(adds, targetIdx);
    }
    function rollbackEntityStep() {
      try {
        if (needInit) {
          if (addsAbsent) { delete e.additionalIdentities; }
          else { Object.defineProperty(e, 'additionalIdentities', dAdds); }
        }
        else { Object.defineProperty(adds, 'length', { value: oldLength }); }
      } catch (rbErr) { void rbErr; }
      return verifyRestored();
    }
    function describeResidual() {
      var info = { field: 'unknown', addsLength: null, byKeyHasTarget: false };
      try {
        var dR = Object.getOwnPropertyDescriptor(e, 'additionalIdentities');
        if (!dR) info.field = 'absent';
        else if (!('value' in dR)) info.field = 'accessor';
        else if (dR.value === undefined) info.field = 'undefined';
        else if (Array.isArray(dR.value)) { info.field = 'array'; info.addsLength = dR.value.length; }
        else info.field = 'other';
      } catch (eR1) { void eR1; }
      try { info.byKeyHasTarget = !!Object.getOwnPropertyDescriptor(reg.byKey, key); } catch (eR2) { void eR2; }
      return info;
    }
    function rollbackFailedResult(failedAt) {
      return { status: 'INVALID', reason: 'rollback_failed', rollbackFailed: true, failedAt: failedAt, residual: describeResidual() };
    }
    function failAfterWrite(reason) {
      if (rollbackEntityStep()) return { status: 'INVALID', reason: reason };
      return rollbackFailedResult(reason);
    }
    if (needInit) {
      var prepared = [newIdentity];
      try { Object.defineProperty(e, 'additionalIdentities', { value: prepared, writable: true, enumerable: true, configurable: true }); }
      catch (err0) { if (verifyRestored()) return { status: 'INVALID', reason: 'additional_identities_not_writable' }; return failAfterWrite('additional_identities_not_writable'); }
      /* R2 第三项：写后完整复核——自有数据属性、value 恒等、
         writable/enumerable/configurable 均为预期 true。 */
      var dInit = Object.getOwnPropertyDescriptor(e, 'additionalIdentities');
      if (!dInit || !('value' in dInit) || dInit.value !== prepared || dInit.writable !== true || dInit.enumerable !== true || dInit.configurable !== true) return failAfterWrite('additional_identities_not_writable');
    } else {
      try { Object.defineProperty(adds, targetIdx, { value: newIdentity, writable: true, enumerable: true, configurable: true }); }
      catch (err1) { if (verifyRestored()) return { status: 'INVALID', reason: 'additional_identities_not_writable' }; return failAfterWrite('additional_identities_not_writable'); }
      var dNew = Object.getOwnPropertyDescriptor(adds, targetIdx);
      if (!dNew || !('value' in dNew) || dNew.value !== newIdentity || dNew.writable !== true || dNew.enumerable !== true || dNew.configurable !== true || adds.length !== oldLength + 1) return failAfterWrite('additional_identities_not_writable');
    }
    try { Object.defineProperty(reg.byKey, key, { value: e, writable: true, enumerable: true, configurable: true }); }
    catch (err2) { return failAfterWrite('registry_write_failed'); }
    var dKey = Object.getOwnPropertyDescriptor(reg.byKey, key);
    if (!dKey || !('value' in dKey) || dKey.value !== e || dKey.writable !== true || dKey.enumerable !== true || dKey.configurable !== true) {
      var keyRemoved = false;
      try { delete reg.byKey[key]; } catch (err3) { void err3; }
      keyRemoved = !Object.getOwnPropertyDescriptor(reg.byKey, key);
      if (!keyRemoved) { rollbackEntityStep(); return rollbackFailedResult('registry_write_failed'); }
      return failAfterWrite('registry_write_failed');
    }
    return { status: 'BOUND', internalId: internalId };
  }

  /* 存量实体登记（legacy 回填专用）：把既有内部 ID 绑定为某外部身份的主映射。
     内部 ID 由调用方给出（存量冻结），本函数绝不生成或改写它。
     返回 BOUND（新建绑定）/ UNCHANGED（已存在同一绑定，幂等）/ CONFLICT / INVALID。 */
  function registerExisting(reg, idn, internalId, content) {
    var v = validateIdentity(idn);
    if (!v.ok) return { status: 'INVALID', missing: v.missing };
    if (!internalId) return { status: 'INVALID', missing: ['internal_id'] };
    var key = identityKeyOf(idn);
    var byKeyHit = reg.byKey[key];
    var byIntHit = reg.byInternal[internalId];
    /* R8-R4-R1 第三项：检查顺序——先结构、后读字段。取得两个命中
       后禁止立即读取其任何字段（旧实现先读 byKeyHit.internalId，
       若该字段是 getter 会在防守前被执行）；先对双方做无 getter
       的结构验证（entityShapeOk 全程走描述符），双方都通过后，
       internalId/identity/additionalIdentities 已被证明是普通数据
       属性，后续读取不执行任何代码。结构无效 → index_entity_invalid
       冲突，不改索引、不改实体。addConflict 只读请求 idn（已由本
       函数首行 validateIdentity 校验的调用方对象）与 reg.conflicts，
       不读命中实体的任何字段，错误路径同样安全。 */
    if (byKeyHit && !entityShapeOk(byKeyHit)) {
      var cE1 = addConflict(reg, 'index_entity_invalid', idn, internalId, 'byKey 命中的实体结构损坏（字段访问器化/主身份/附加身份不合法），拒绝修复与绑定', key + '|index_entity_invalid|register|' + internalId);
      return { status: 'CONFLICT', conflictId: cE1.id };
    }
    if (byIntHit && !entityShapeOk(byIntHit)) {
      var cE2 = addConflict(reg, 'index_entity_invalid', idn, internalId, 'byInternal 命中的实体结构损坏（字段访问器化/主身份/附加身份不合法），拒绝修复与绑定', key + '|index_entity_invalid|register|' + internalId);
      return { status: 'CONFLICT', conflictId: cE2.id };
    }
    if (byKeyHit && byKeyHit.internalId !== internalId) {
      var c = addConflict(reg, 'duplicate_internal', idn, internalId, '外部身份已绑定到另一内部实体（存量登记）', key + '|duplicate_internal|register');
      return { status: 'CONFLICT', conflictId: c.id };
    }
    if (byIntHit && byIntHit.internalId !== internalId) {
      var cE3 = addConflict(reg, 'index_entity_invalid', idn, internalId, 'byInternal 索引键与实体 internalId 不一致（索引损坏），拒绝修复与绑定', key + '|index_entity_invalid|register|' + internalId);
      return { status: 'CONFLICT', conflictId: cE3.id };
    }
    /* R8 第二项：归属判定放宽到实体的全部合法键（主身份 + 附加
       身份）。旧实现只认主身份键，经附加身份登记已绑定实体时会
       误报 conflicting；同时下方双索引命中也不再无条件放行。 */
    if (byIntHit && entityKeys(byIntHit, identityKeyOf).indexOf(key) < 0) {
      var c2 = addConflict(reg, 'conflicting_identity_for_entity', idn, internalId, '内部实体的主身份与附加身份均不含此身份键（存量登记）', key + '|conflicting|register|' + internalId);
      return { status: 'CONFLICT', conflictId: c2.id };
    }
    if (byKeyHit && byIntHit) {
      /* R8 第二项：双索引都命中不等于一致。必须验证两个索引指向
         同一个对象、且该键确实属于这个实体（主身份或附加身份）：
         - 同一对象但键不属于该实体 → 索引键错位，冲突拒绝；
         - 不同对象（索引分裂）→ 只有两份内容逐项完全一致（含员工
           确认值与历史，稳定序列化相等）才允许统一引用修复（以
           byInternal 一侧为规范对象，byKey 改指同一对象，不丢弃
           任何一份的信息）；内容有任何差异 → 冲突拒绝，绝不静默
           覆盖其中一份（确认值/历史可能只存在于其中一份）。 */
      if (byKeyHit === byIntHit) {
        if (entityKeys(byKeyHit, identityKeyOf).indexOf(key) < 0) {
          var cK = addConflict(reg, 'index_key_mismatch', idn, internalId, '索引键与实体身份（主+附加）不一致，拒绝按命中放行', key + '|index_key_mismatch|register|' + internalId);
          return { status: 'CONFLICT', conflictId: cK.id };
        }
        return { status: 'UNCHANGED', internalId: internalId };
      }
      /* R8-R3 第二项：分裂双方先过纯 JSON 验证。运行时实体（经
         importRecord/业务代码构造）可能含 NaN、Date、循环引用等
         非 JSON 值，其 stableStringify 文本会与另一份实体的文本
         相撞（如 NaN 与 null），凭文本相等统一将造成静默误判；
         无法验证时明确冲突拒绝，不统一、不覆盖、不抛栈溢出。 */
      if (!isPlainJsonValue(byKeyHit) || !isPlainJsonValue(byIntHit)) {
        var cU = addConflict(reg, 'index_split_unverifiable', idn, internalId, '索引分裂且至少一份实体含非纯 JSON 值，无法安全比较，拒绝统一与覆盖', key + '|index_split_unverifiable|register|' + internalId);
        return { status: 'CONFLICT', conflictId: cU.id };
      }
      if (stableStringify(byKeyHit) === stableStringify(byIntHit)) {
        /* R8-R3 第三项：统一必须覆盖实体的全部键（主身份 + 全部
           附加身份），不能只修请求键——其余键若仍指向旧分裂对象，
           经那些键访问到的仍是另一份实体。先全量核查：每个键当前
           只能指向分裂双方之一或缺失；指向第三个对象说明分裂范
           围超出双索引，整笔拒绝、不做部分统一。 */
        var allKeys = entityKeys(byIntHit, identityKeyOf);
        for (var ki = 0; ki < allKeys.length; ki++) {
          var curK = reg.byKey[allKeys[ki]];
          if (curK !== undefined && curK !== byKeyHit && curK !== byIntHit) {
            var cT = addConflict(reg, 'index_split_conflict', idn, internalId, '实体的其他身份键指向第三个对象（分裂范围超出双索引），拒绝部分统一', key + '|index_split_third|register|' + internalId);
            return { status: 'CONFLICT', conflictId: cT.id };
          }
        }
        allKeys.forEach(function (k2) { reg.byKey[k2] = byIntHit; });
        return { status: 'UNCHANGED', internalId: internalId, repaired: 'index_unified' };
      }
      var cS = addConflict(reg, 'index_split_conflict', idn, internalId, '同一实体的 byKey/byInternal 指向内容不同的两个对象（索引分裂），拒绝静默覆盖', key + '|index_split|register|' + internalId);
      return { status: 'CONFLICT', conflictId: cS.id };
    }
    /* R6 第四项：单边索引缺失（注册表内部不一致）不得新建实体覆盖
       旧实体——旧实现会走到下方创建新实体，把 byInternal 里的旧
       实体（含员工确认值、确认历史）静默换掉。现改为补齐缺失的
       一边索引、指向同一实体对象，并标注 repaired：
       - 只有 byKey 命中 → 补 byInternal；
       - 只有 byInternal 命中（其主身份键已在上方校验正是本键）
         → 补 byKey。 */
    if (byKeyHit && !byIntHit) {
      /* R8 第二项：单边修复前同样验证键归属——键必须能由该实体的
         身份（主+附加）重算出来，否则可能是索引键错位指向了错误
         实体，拒绝把 internalId 绑定过去。 */
      if (entityKeys(byKeyHit, identityKeyOf).indexOf(key) < 0) {
        var cK2 = addConflict(reg, 'index_key_mismatch', idn, internalId, 'byKey 索引键与实体身份（主+附加）不一致，拒绝单边修复绑定', key + '|index_key_mismatch|register|' + internalId);
        return { status: 'CONFLICT', conflictId: cK2.id };
      }
      reg.byInternal[internalId] = byKeyHit; return { status: 'UNCHANGED', internalId: internalId, repaired: 'byInternal' };
    }
    if (!byKeyHit && byIntHit) { reg.byKey[key] = byIntHit; return { status: 'UNCHANGED', internalId: internalId, repaired: 'byKey' }; }
    var entity = { internalId: internalId, identity: { source_system: idn.source_system, source_account: idn.source_account, entity_type: idn.entity_type, external_id_raw: idn.external_id_raw },
      content: content || {}, contentHash: contentHash(content || {}, idn.entity_type, reg.canonVersion), canonVersion: reg.canonVersion,
      sourceVersion: null, sourceUpdatedAt: null, sourceValue: content || {}, parsedValue: null, confirmedValue: null, archived: false, legacy: true };
    reg.byKey[key] = entity; reg.byInternal[internalId] = entity;
    return { status: 'BOUND', internalId: internalId };
  }

  /* R5 6.4：resolution 白名单。只有表内三种处置被接受，未知值
     （含空串、null、拼写错误）明确拒绝，绝不默认转为 RESOLVED。 */
  var RESOLUTIONS = { keep_existing: 'RESOLVED', reject: 'REJECTED', need_more_info: 'NEEDS_MORE_INFO' };
  function resolveConflict(reg, conflictId, resolution, operator) {
    for (var i = 0; i < reg.conflicts.length; i++) {
      var c = reg.conflicts[i];
      if (c.id === conflictId) {
        if (c.status === 'RESOLVED' || c.status === 'REJECTED') return { ok: true, already: true, status: c.status };
        if (!Object.prototype.hasOwnProperty.call(RESOLUTIONS, resolution)) return { ok: false, reason: 'unknown_resolution' };
        c.status = RESOLUTIONS[resolution];
        c.resolution = resolution; c.resolvedBy = operator || null; c.resolvedAt = new Date().toISOString();
        return { ok: true, status: c.status };
      }
    }
    return { ok: false, reason: 'conflict_not_found' };
  }

  /* 跨来源疑似重复（只提示不合并）：内容哈希相同的不同键实体。
     R5 6.5：按哈希分组后输出组内全部无序对——旧实现只把每个新实体
     与组内第一个实体配对，三方以上重复组会漏报成员间关系；且同一
     实体经附加身份占多个键时会产生自配对。现按 internalId 去重
     后两两成对，结果完整且无自配对。本函数只提供候选，绝不合并。
     R6 第四项：无效内容哈希（缺失/null/空串/非字符串）不得参与
     分组——旧实现会把所有缺哈希的实体以 undefined 为键分到同一
     组，伪造出大量「疑似重复」。无效哈希实体改由 report 接口的
     invalidHashEntities 显式列出（按 internalId），不静默丢失、
     也不参与配对。 */
  function findPossibleDuplicatesReport(reg) {
    var groups = Object.create(null), order = [], invalid = [];
    Object.keys(reg.byKey).forEach(function (k) {
      var e = reg.byKey[k];
      if (typeof e.contentHash !== 'string' || e.contentHash === '') {
        if (invalid.indexOf(e.internalId) < 0) invalid.push(e.internalId);
        return;
      }
      if (!groups[e.contentHash]) { groups[e.contentHash] = []; order.push(e.contentHash); }
      if (groups[e.contentHash].indexOf(e.internalId) < 0) groups[e.contentHash].push(e.internalId);
    });
    var pairs = [];
    order.forEach(function (h) {
      var ids = groups[h];
      for (var i = 0; i < ids.length; i++) for (var j = i + 1; j < ids.length; j++) pairs.push([ids[i], ids[j]]);
    });
    return { pairs: pairs, invalidHashEntities: invalid };
  }
  function findPossibleDuplicates(reg) { return findPossibleDuplicatesReport(reg).pairs; }

  function exportState(reg) {
    return JSON.stringify({ byKey: reg.byKey, conflicts: reg.conflicts, reviewEvents: reg.reviewEvents, canonVersion: reg.canonVersion, keyVersion: reg.keyVersion || KEY_ENCODING });
  }
  var KNOWN_CANON_VERSIONS = ['canon-v1', 'canon-v2', 'canon-v3'];
  function registryError(code, detail) { var e = new Error('registry_' + code + (detail ? ':' + detail : '')); e.code = 'registry_' + code; return e; }
  /* R8 第一/二项共用：稳定序列化（对象键递归排序后的 JSON 文本）。
     用于判定同一 internalId 的多个实体副本是否「逐项完全一致」：
     键序不同但内容相同的副本不被误判冲突；任何字段差异（含员工
     确认值、确认历史、附加身份列表）都会产生不同文本 → 判冲突。
     输入只来自 JSON.parse 结果或内存实体（纯 JSON 值），无循环
     引用与函数。 */
  function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    /* R8-R4-R1-R2：数组分支改下标迭代——v 可能是经 isPlainJsonValue
       放行的「假 Array.prototype」数组（指纹限制下可接受但无 map
       方法），调用 v.map 会抛 TypeError；下标读取不依赖原型方法。
       对象分支的 Object.keys(...).sort().map(...) 操作的是
       Object.keys 新建的标准数组，不受影响，保留。 */
    if (Array.isArray(v)) {
      var parts = [];
      for (var i = 0; i < v.length; i++) parts.push(stableStringify(v[i]));
      return '[' + parts.join(',') + ']';
    }
    return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + stableStringify(v[k]); }).join(',') + '}';
  }
  /* R8-R3 第二项：严格纯 JSON 值验证。stableStringify 的文本相等
     只有对纯 JSON 值才等价于内容相等：非有限数会被文本化为 null
     （与真 null 撞文本）、undefined/函数会消失、Date 的自有键为空
     会与 {} 撞文本、稀疏数组与 [undefined] 会撞文本、循环引用会
     无限递归。因此凡以「文本相等 ⇒ 内容一致」作放行/统一决定的
     比较点（importState 副本判定、registerExisting 分裂判定），
     必须先用本函数验证参与比较的实体为纯 JSON 值，不满足即拒绝
     比较（fail-closed），绝不凭撞文本判定一致。
     纯 JSON 值定义：null / 布尔 / 有限数 / 字符串 / 稠密数组
     （无空洞、无附加属性、元素皆纯 JSON）/ 普通对象（原型为
     Object.prototype 或 null、属性值皆纯 JSON、无循环引用；
     同一对象在非祖先位置重复出现不算循环）。 */
  /* R8-R4-R1 第一项：判定 p 是否为某个 realm 的 Object.prototype。
     依据（结构指纹，与 realm 无关）：任何 realm 的 Object.prototype
     都同时满足——(1) 自身原型为 null；(2) 有自有数据属性
     'constructor'，其值是一个函数 F；(3) F 的自有数据属性
     'prototype' 恰好指回 p 本身（Object 与 Object.prototype 互指）。
     自定义原型无法同时满足：Object.create(null) 作原型时无
     constructor 自有属性；普通对象作原型时其原型是 Object.prototype
     而非 null；多层自定义链在第一层即因原型非 null 被拒。跨 realm
     的 Object.prototype 结构指纹相同，故可被接受。残余限制：蓄意
     伪造（手工给 null 原型对象装上 constructor 并令某函数的
     prototype 指回它）可通过本判定——这需要主动构造，在本产品
     （本机单用户、数据来自 JSON 与自有代码）的威胁模型内如实记
     录为已知限制，不以本判定冒充密码学级证明。全部读取走描述符，
     不执行任何 getter。 */
  function isObjectPrototype(p) {
    if (!p || typeof p !== 'object') return false;
    if (Object.getPrototypeOf(p) !== null) return false;
    var d = Object.getOwnPropertyDescriptor(p, 'constructor');
    if (!d || !('value' in d) || typeof d.value !== 'function') return false;
    var cd = Object.getOwnPropertyDescriptor(d.value, 'prototype');
    return !!cd && 'value' in cd && cd.value === p;
  }
  /* 数组原型判定（isPlainJsonValue 与 entityShapeOk 共用）：arr 的
     原型须为某个 realm 的标准 Array.prototype——它本身是一个数组
     （Array.isArray 跨 realm 成立），且它的原型通过 isObjectPrototype
     指纹判定。Array.isArray 对换过原型的数组仍为 true，故必须另查
     原型。限制同 isObjectPrototype：指纹可被蓄意构造伪造，如实记
     录，不冒充绝对身份验证。 */
  function arrayProtoOk(arr) {
    var aproto = Object.getPrototypeOf(arr);
    return Array.isArray(aproto) && isObjectPrototype(Object.getPrototypeOf(aproto));
  }

  function isPlainJsonValue(v, ancestors) {
    if (v === null) return true;
    var t = typeof v;
    if (t === 'string' || t === 'boolean') return true;
    if (t === 'number') return isFinite(v);
    if (t !== 'object') return false; /* undefined / function / symbol / bigint */
    var seen = ancestors || [];
    if (seen.indexOf(v) >= 0) return false; /* 循环引用 */
    seen.push(v);
    try {
      /* R8-R4 第一项：必须核对全部自有属性，而非只有 Object.keys
         的可枚举字符串键——Symbol 属性、不可枚举属性、访问器属性
         都不在 Object.keys 结果里，而 stableStringify 同样看不见
         它们；若不拒绝，两份仅在隐藏属性上不同的实体会被误判为
         内容相同。现用 getOwnPropertySymbols（有任一 Symbol 自有
         属性即拒绝）+ getOwnPropertyNames + getOwnPropertyDescriptor
         逐项核对：每个自有属性必须是可枚举的数据属性，递归时读
         描述符的 value，全程不执行任何 getter/setter。三者与
         Object.getPrototypeOf 均为 ES5/ES6 标准 API，目标环境
         （现代 Chrome/Edge、Android WebView、QQ 浏览器、Node）
         全部支持，无需降级分支。 */
      if (Object.getOwnPropertySymbols(v).length > 0) return false;
      var names = Object.getOwnPropertyNames(v);
      var i, desc;
      if (Array.isArray(v)) {
        /* R8-R4-R1 第一项：数组原型也必须验证（arrayProtoOk：原型
           须为某 realm 的标准 Array.prototype）。经 setPrototypeOf
           换成自定义原型的数组、数组子类实例均在此被拒。 */
        if (!arrayProtoOk(v)) return false;
        /* 稠密纯数组的自有属性名恰为 'length' + 全部下标字符串；
           空洞（缺下标）、非标准附加属性都会使计数或构成不符。 */
        if (names.length !== v.length + 1) return false;
        for (i = 0; i < names.length; i++) {
          if (names[i] === 'length') continue;
          var n = Number(names[i]);
          if (String(n) !== names[i] || n < 0 || n >= v.length || Math.floor(n) !== n) return false;
        }
        for (i = 0; i < v.length; i++) {
          desc = Object.getOwnPropertyDescriptor(v, String(i));
          if (!desc || !('value' in desc) || !desc.enumerable) return false; /* 访问器元素/不可枚举元素 */
          if (!isPlainJsonValue(desc.value, seen)) return false;
        }
        return true;
      }
      /* R8-R4-R1 第一项：普通对象的原型只接受两种——null，或经
         isObjectPrototype 指纹判定为某 realm 的 Object.prototype。
         （R8-R4 的「原型链深度」判据会误收以 Object.create(null)
         或自定义对象为原型的对象，本轮以指纹判定取代。） */
      var proto = Object.getPrototypeOf(v);
      if (proto !== null && !isObjectPrototype(proto)) return false; /* Date / 类实例 / 自定义原型 */
      for (i = 0; i < names.length; i++) {
        desc = Object.getOwnPropertyDescriptor(v, names[i]);
        if (!desc || !('value' in desc) || !desc.enumerable) return false; /* 访问器属性/不可枚举属性 */
        if (!isPlainJsonValue(desc.value, seen)) return false;
      }
      return true;
    } finally { seen.pop(); }
  }
  /* R8-R4-R1 第二项：无 getter 的身份结构读取。逐字段走
     getOwnPropertyDescriptor：字段必须是可枚举的数据属性，值从
     descriptor.value 取得，全程不读原对象属性、不执行任何
     getter/setter。身份对象自身也须是普通对象（原型 null 或某
     realm 的 Object.prototype）。返回由描述符值重组的纯身份对象
     （只含四元组字段），或 null（结构不合法）。 */
  function identityViaDescriptors(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    var proto = Object.getPrototypeOf(obj);
    if (proto !== null && !isObjectPrototype(proto)) return null;
    if (Object.getOwnPropertySymbols(obj).length > 0) return null;
    var out = {}, fields = ['source_system', 'source_account', 'entity_type', 'external_id_raw'], i, d;
    for (i = 0; i < fields.length; i++) {
      d = Object.getOwnPropertyDescriptor(obj, fields[i]);
      if (!d || !('value' in d) || !d.enumerable) return null; /* 缺失/访问器/不可枚举 */
      out[fields[i]] = d.value;
    }
    return validateIdentity(out).ok ? out : null;
  }
  /* R8-R4 第三项 + R8-R4-R1 第二项：实体结构防守（registerExisting
     专用），全部字段经描述符读取、零 getter 执行：
       - 实体本身须为普通对象（原型判定同上）且无 Symbol 自有属性；
       - internalId / identity / additionalIdentities 三个固定字段
         若存在，必须是可枚举数据属性（internalId 可缺失——缺失时
         由调用方按索引语义处理；identity 必须存在且合法）；
       - identity 与每个附加身份经 identityViaDescriptors 逐字段
         描述符校验；
       - additionalIdentities 必须为 undefined（无此属性）或合法
         稠密数组：原型须为标准 Array.prototype（R8-R4-R1-R1 补）、
         无 Symbol、无附加属性、每个元素为数据属性且通过身份校验
         （元素读取同样走描述符）。
     注意：本检查只验结构，不验 internalId 与请求是否一致——一致
     性由 registerExisting 在结构验证通过后比较（届时 internalId
     已被证明是普通数据属性，读取不执行任何代码）。 */
  function entityShapeOk(ent) {
    if (!ent || typeof ent !== 'object' || Array.isArray(ent)) return false;
    var proto = Object.getPrototypeOf(ent);
    if (proto !== null && !isObjectPrototype(proto)) return false;
    if (Object.getOwnPropertySymbols(ent).length > 0) return false;
    var dId = Object.getOwnPropertyDescriptor(ent, 'internalId');
    if (dId && (!('value' in dId) || !dId.enumerable || typeof dId.value !== 'string' || !dId.value)) return false;
    var dIdentity = Object.getOwnPropertyDescriptor(ent, 'identity');
    if (!dIdentity || !('value' in dIdentity) || !dIdentity.enumerable) return false;
    if (!identityViaDescriptors(dIdentity.value)) return false;
    var dAdds = Object.getOwnPropertyDescriptor(ent, 'additionalIdentities');
    if (!dAdds) return true; /* 无此属性 = undefined */
    if (!('value' in dAdds) || !dAdds.enumerable) return false;
    var adds = dAdds.value;
    if (adds === undefined) return true;
    if (!Array.isArray(adds)) return false;
    /* R8-R4-R1-R1：附加身份数组的原型也必须验证——Array.isArray 对
       经 setPrototypeOf 换成自定义原型（含 null、多层自定义、伪造
       指纹）的数组仍返回 true，仅查类型会放行。在读取任何元素
       之前用 arrayProtoOk 判定（与 isPlainJsonValue 同一指纹策略，
       可伪造限制相同并已如实记录）。 */
    if (!arrayProtoOk(adds)) return false;
    if (Object.getOwnPropertySymbols(adds).length > 0) return false;
    if (Object.getOwnPropertyNames(adds).length !== adds.length + 1) return false; /* 空洞或附加属性 */
    for (var i = 0; i < adds.length; i++) {
      var dEl = Object.getOwnPropertyDescriptor(adds, String(i));
      if (!dEl || !('value' in dEl) || !dEl.enumerable) return false; /* 访问器元素/空洞 */
      if (!identityViaDescriptors(dEl.value)) return false;
    }
    return true;
  }
  /* R4 第三项：注册表导入完整性校验。在重建 byInternal 之前逐项验证，
     任一不满足即抛 registry_* 错误明确失败——绝不静默降级为空注册表、
     绝不让损坏数据进入后续导入。校验项：
       - 顶层必须是对象，byKey 必须是对象，conflicts/reviewEvents 必须是数组；
       - canonVersion 必须可识别，keyVersion 必须可识别（缺失 = legacy-v1 迁移）；
       - 每个实体：internalId 为非空字符串；identity 四元组完整（validateIdentity）；
       - 每个 byKey 键必须与其实体（主身份或 additionalIdentities 之一）
         按该注册表声明的编码重算一致——防键/实体错位与键碰撞残留；
       - 同一 internalId 出现在多个键下时，各条实体内容必须逐字一致
         （additionalIdentities 的合法形态），否则判内部 ID 冲突；
       - 每个实体的主身份键必须存在于 byKey 中。
     legacy-v1（无 keyVersion）迁移：先按旧裸拼接校验键一致，再按 esc-v2
     重算全部键；重算后若两键相撞且指向不同实体 → 明确失败（历史碰撞
     已造成的数据丢失无法在此恢复，只能阻断并留待人工处理）。 */
  function importState(json) {
    var data;
    try { data = JSON.parse(json); } catch (e) { throw registryError('unparseable'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw registryError('not_object');
    if (!data.byKey || typeof data.byKey !== 'object' || Array.isArray(data.byKey)) throw registryError('bykey_invalid');
    if (data.conflicts !== undefined && !Array.isArray(data.conflicts)) throw registryError('conflicts_invalid');
    if (data.reviewEvents !== undefined && !Array.isArray(data.reviewEvents)) throw registryError('review_events_invalid');
    /* R8-R3 第一项：版本字段严格区分「缺失」与「非法」。旧实现用
       || 兜底：空字符串/null 被当作缺失自动降级为当前版本，损坏的
       版本字段会被误读成合法旧注册表。现规定：字段为 undefined
       （确实缺失）才走兼容默认；字段存在则必须是非空字符串且属于
       已知集合，空串/null/数字/布尔/对象/数组一律明确拒绝。 */
    var canon;
    if (data.canonVersion === undefined) canon = CANON_VERSION;
    else if (typeof data.canonVersion !== 'string' || !data.canonVersion) throw registryError('canon_version_invalid', typeof data.canonVersion);
    else if (KNOWN_CANON_VERSIONS.indexOf(data.canonVersion) < 0) throw registryError('unknown_canon_version', data.canonVersion);
    else canon = data.canonVersion;
    var kv;
    if (data.keyVersion === undefined) kv = 'legacy-v1';
    else if (typeof data.keyVersion !== 'string' || !data.keyVersion) throw registryError('key_version_invalid', typeof data.keyVersion);
    else if (data.keyVersion !== 'legacy-v1' && data.keyVersion !== KEY_ENCODING) throw registryError('unknown_key_version', data.keyVersion);
    else kv = data.keyVersion;
    var keyOf = kv === KEY_ENCODING ? identityKeyOf : legacyKeyOf;
    var conflicts = data.conflicts || [];
    conflicts.forEach(function (c, i) {
      if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !c.id || typeof c.kind !== 'string' || !c.kind) throw registryError('conflict_entry_invalid', String(i));
    });
    /* R5 6.1：重建用映射一律无原型对象——internalId 来自不可信 JSON，
       '__proto__' 作键时普通对象赋值会被吞（设原型失败即静默丢弃），
       实体会在重建中无声消失；无原型对象上它是普通自有键。 */
    var byInternalJson = Object.create(null);
    var newByKey = Object.create(null);
    /* R8 第一项：规范实体表。同一 internalId 无论出现在多少个键
       下（主身份 + 附加身份），newByKey 的每个键与最终的 byInternal
       都必须指向同一个规范对象——旧实现把每个键下的 JSON 副本
       分别放进 newByKey，byInternal 又由遍历 newByKey 派生，结果
       三处引用各指一个对象，后续经任一键修改实体时其他键看到的
       是旧副本，分裂无声发生。 */
    var canonicalById = Object.create(null);
    Object.keys(data.byKey).forEach(function (k) {
      var ent = data.byKey[k];
      if (!ent || typeof ent !== 'object' || Array.isArray(ent)) throw registryError('entity_invalid', k);
      if (typeof ent.internalId !== 'string' || !ent.internalId) throw registryError('entity_internal_id_invalid', k);
      var v = validateIdentity(ent.identity);
      if (!v.ok) throw registryError('entity_identity_invalid', k);
      /* R6 第四项：additionalIdentities 结构校验。存在时必须是数组，
         每项必须是合法四元组对象（字段类型/完整性与主身份同标准，
         validateIdentity 不通过即拒绝，账号缺失同样不接受），不得与
         主身份键重复、不得在附加列表内重复。非法数据明确抛错，
         绝不静默忽略或丢弃。 */
      var adds = ent.additionalIdentities;
      if (adds !== undefined) {
        if (!Array.isArray(adds)) throw registryError('additional_identities_invalid', k);
        var seenAdd = Object.create(null);
        /* R8-R4-R1-R2：改下标迭代，不调用数组自身的 forEach（同
           entityKeys 的理由：不依赖被验数组的原型方法）。 */
        for (var ai = 0; ai < adds.length; ai++) {
          var a = adds[ai];
          if (!a || typeof a !== 'object' || Array.isArray(a)) throw registryError('additional_identity_invalid', k + ':' + ai);
          var av = validateIdentity(a);
          if (!av.ok) throw registryError('additional_identity_invalid', k + ':' + ai);
          var ak = keyOf(a);
          if (ak === keyOf(ent.identity)) throw registryError('additional_duplicates_primary', k + ':' + ai);
          if (seenAdd[ak]) throw registryError('additional_duplicate', k + ':' + ai);
          seenAdd[ak] = true;
        }
      }
      /* R8-R4 第四项：canon-v3 注册表的实体必须是纯 JSON 值。
         调用链调查（R8-R4-IMPORTSTATE-CALLCHAIN.md）证实存在绕过
         importRecord 的传播路径：loadRegistry 载入的注册表可被
         buildBackup 直接导出进备份、被 recover 原样写回、被
         importBatch 的工作副本整体携带——这些路径都不会对存量
         实体重跑 importRecord 的 canon-v3 类型/有限性检查。JSON
         .parse 产物唯一的非纯情形是数字溢出字面量（1e999 →
         Infinity）等非有限数，故在导入期以纯 JSON 性把关即可封堵
         （只验结构纯度，不验业务字段类型——类型语义仍归
         importRecord 的 canonicalize）。仅限 canon-v3：canon-v1/v2
         的历史语义（如 v1 对 NaN 的 n:NaN 编码）保持不变，不按
         v3 规则拒绝或重算旧数据。 */
      if (canon === CANON_VERSION && !isPlainJsonValue(ent)) throw registryError('entity_content_invalid', k);
      if (entityKeys(ent, keyOf).indexOf(k) < 0) throw registryError('key_mismatch', k);
      var primaryNewKey = identityKeyOf(ent.identity);
      var isPrimary = (keyOf(ent.identity) === k);
      var newKey = isPrimary ? primaryNewKey : null;
      if (!isPrimary) {
        /* 附加身份键：按该附加四元组重算新键。
           R8-R4-R1-R2：改下标迭代，不调用数组自身的 forEach。 */
        var addsArr = ent.additionalIdentities || [];
        for (var aai = 0; aai < addsArr.length; aai++) { if (keyOf(addsArr[aai]) === k) newKey = identityKeyOf(addsArr[aai]); }
      }
      if (!newKey) throw registryError('key_mismatch', k);
      if (newByKey[newKey] && newByKey[newKey].internalId !== ent.internalId) throw registryError('key_collision_after_migration', newKey);
      /* R8 第一项：副本一致性按稳定序列化判定（键序差异不算冲突，
         内容差异必拒绝，错误码沿用 internal_id_conflict）；一致的
         副本统一收敛到规范对象，绝不各留一份引用。
         R8-R3 第二项：重复副本的判定同样先验纯 JSON 性——JSON.parse
         产物一般为纯 JSON，但 1e999 等溢出字面量会解析成 Infinity，
         其文本与 null 相撞，不得据此把 Infinity 副本与 null 副本
         判为一致。无副本比较的单键实体不因此受影响（沿用既有
         读取行为），只有在确实存在第二份副本需要判等时才验证。 */
      if (byInternalJson[ent.internalId]) {
        var prevCanon = canonicalById[ent.internalId];
        if (!isPlainJsonValue(ent) || !isPlainJsonValue(prevCanon) || byInternalJson[ent.internalId] !== stableStringify(ent)) throw registryError('internal_id_conflict', ent.internalId);
      }
      byInternalJson[ent.internalId] = stableStringify(ent);
      var canonEnt = canonicalById[ent.internalId];
      if (!canonEnt) { canonicalById[ent.internalId] = ent; canonEnt = ent; }
      newByKey[newKey] = canonEnt;
    });
    /* 每个实体的主身份键必须存在 */
    Object.keys(byInternalJson).forEach(function (iid) {
      var ent = JSON.parse(byInternalJson[iid]);
      if (!newByKey[identityKeyOf(ent.identity)] || newByKey[identityKeyOf(ent.identity)].internalId !== iid) throw registryError('primary_key_missing', iid);
    });
    /* R6 第四项：键覆盖校验——每个实体的全部键（主身份 + 附加
       身份）在重建后的映射中都必须存在且指向同一实体。附加身份
       声称的键在 byKey 中缺失、或实际指向另一实体（与他人的主
       身份或附加身份冲突），都说明注册表不一致，明确拒绝。 */
    Object.keys(byInternalJson).forEach(function (iid) {
      var ent = JSON.parse(byInternalJson[iid]);
      entityKeys(ent, identityKeyOf).forEach(function (nk) {
        if (!newByKey[nk] || newByKey[nk].internalId !== iid) throw registryError('key_coverage_missing', nk);
      });
    });
    var reg = createRegistry();
    reg.byKey = newByKey; reg.conflicts = conflicts; reg.reviewEvents = data.reviewEvents || [];
    reg.canonVersion = canon; reg.keyVersion = KEY_ENCODING;
    Object.keys(newByKey).forEach(function (k) { reg.byInternal[newByKey[k].internalId] = newByKey[k]; });
    return reg;
  }

  var api = { createRegistry: createRegistry, importRecord: importRecord, registerExisting: registerExisting, bindAdditionalIdentity: bindAdditionalIdentity,
    resolveConflict: resolveConflict, setConfirmation: setConfirmation, revokeConfirmation: revokeConfirmation,
    displayValue: displayValue, findPossibleDuplicates: findPossibleDuplicates, findPossibleDuplicatesReport: findPossibleDuplicatesReport, exportState: exportState, importState: importState,
    contentHash: contentHash, canonicalize: canonicalize, identityKeyOf: identityKeyOf, validateIdentity: validateIdentity,
    versionOrder: versionOrder, compareOrder: compareOrder,
    CANON_VERSION: CANON_VERSION, HASH_ALGO: HASH_ALGO, FIELD_SPECS: FIELD_SPECS, KEY_ENCODING: KEY_ENCODING, _legacyKeyOf: legacyKeyOf,
    isPlainJsonValue: isPlainJsonValue,
    _stableStringify: stableStringify, _isPlainJsonValue: isPlainJsonValue };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.Identity = api;
})();
