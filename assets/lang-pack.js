/* ===========================================================
   lang-pack.js — 多语言词汇包（P1-4-LANG）
   全局暴露：window.LangPack

   设计原则：
   1. 语言差异只存在于本文件的 pack 里：解析（p0-parse）、匹配
      （matching）、评分（opp-score）、翻译识别（translate）都只通过
      LangPack 取词汇，不再把某门语言的规则零散写进英文正则。
   2. 新增一门语言 = 新增一个 pack 并登记到 PACKS（顺序即优先级）；
      主流程零改动。已启用：es / fr / de / ar / hi；ru 仍预留
      （值为 null 表示暂无词汇包，解析护栏会对这类文字降置信度，
      不冒充支持）。
   3. pack 全部字段可选，缺失即该语言该项不支持；所有 pack 正则
      只作「英/中规则未命中时」的后备，永不抢占英/中既有结果。
   4. 纯数据 + 纯函数，无 DOM、无网络、无存储。
   =========================================================== */
(function () {
  'use strict';

  var root = (typeof window !== 'undefined' ? window : globalThis);

  /* 去重音 + 小写 + 压空格：地名归一与翻译识别的统一键形态 */
  function foldKey(s) {
    var t = String(s || '').toLowerCase();
    if (t.normalize) t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    /* ё→е（俄语地名/词形常见混写）、ı→i（土耳其无点 i，无 NFD 分解） */
    return t.replace(/ё/g, 'е').replace(/ı/g, 'i').replace(/\s+/g, ' ').trim();
  }

  /* ---------------- 地名归一（西/法写法 → 英文 canonical） ----------------
     键为 foldKey 形态（去重音小写）。只收录常见目的港/城市，
     查不到时保留买家原文，不猜。 */
  var CITY_MAP = {
    'hamburgo': 'Hamburg', 'hambourg': 'Hamburg',
    'roterdam': 'Rotterdam', 'rotterdam': 'Rotterdam',
    'amberes': 'Antwerp', 'anvers': 'Antwerp',
    'genova': 'Genoa', 'genes': 'Genoa',
    'marsella': 'Marseille', 'marseille': 'Marseille',
    'lisboa': 'Lisbon', 'lisbonne': 'Lisbon',
    'oporto': 'Porto', 'porto': 'Porto',
    'burdeos': 'Bordeaux', 'bordeaux': 'Bordeaux',
    'dunkerque': 'Dunkirk',
    'le havre': 'Le Havre',
    'colonia': 'Cologne', 'francfort': 'Frankfurt',
    'valencia': 'Valencia', 'barcelona': 'Barcelona', 'bilbao': 'Bilbao',
    'nantes': 'Nantes', 'bremen': 'Bremen', 'stuttgart': 'Stuttgart',
    'munich': 'Munich', 'santander': 'Santander', 'vigo': 'Vigo',
    'cadiz': 'Cadiz', 'algeciras': 'Algeciras', 'sevilla': 'Seville',
    'munchen': 'Munich', 'koln': 'Cologne',
    'هامبورغ': 'Hamburg', 'روتردام': 'Rotterdam', 'دبي': 'Dubai',
    'جدة': 'Jeddah', 'الدمام': 'Dammam', 'الكويت': 'Kuwait City',
    'الدوحة': 'Doha', 'مسقط': 'Muscat', 'أبوظبي': 'Abu Dhabi',
    'हैम्बर्ग': 'Hamburg', 'मुंबई': 'Mumbai', 'दिल्ली': 'Delhi',
    'चेन्नई': 'Chennai', 'कोलकाता': 'Kolkata', 'मुन्द्रा': 'Mundra',
    'xangai': 'Shanghai', 'roterda': 'Rotterdam', 'munique': 'Munich',
    'nova iorque': 'New York', 'santos': 'Santos',
    'гамбург': 'Hamburg', 'роттердам': 'Rotterdam', 'дубай': 'Dubai',
    'шанхай': 'Shanghai', 'мюнхен': 'Munich', 'стамбул': 'Istanbul',
    'новороссийск': 'Novorossiysk', 'владивосток': 'Vladivostok',
    'санкт-петербург': 'St. Petersburg', 'москва': 'Moscow'
  };

  /* ---------------- 匹配词典（accent-fold 后的 token → 英文等价 token） ----------------
     matching.tokenize 在生成 token 后附加英文等价词，让西/法询盘能与
     英文商品库做名称重合。只收品类核心词，避免与英文单词撞义。 */
  var GLOSS = {
    receptor: 'receiver', recepteur: 'receiver',
    empfanger: 'receiver', empfangers: 'receiver',
    emisor: 'transmitter', emetteur: 'transmitter', transmisor: 'transmitter',
    camara: 'camera',
    bateria: 'battery', batterie: 'battery',
    antena: 'antenna', antenne: 'antenna',
    cargador: 'charger', chargeur: 'charger',
    gafas: 'goggles', lunettes: 'goggles',
    moteur: 'motor',
    pantalla: 'screen', ecran: 'screen',
    helice: 'propeller',
    receptores: 'receiver',
    transmissor: 'transmitter', transmissores: 'transmitter',
    alici: 'receiver', alicisi: 'receiver', verici: 'transmitter',
    kamera: 'camera', anten: 'antenna',
    penerima: 'receiver', pemancar: 'transmitter', baterai: 'battery'
  };

  /* ================= 西班牙语 pack ================= */
  var ES = {
    code: 'es',
    qtyPatterns: [
      /(\d[\d.]*)\s*(unidades|unidad|piezas|pieza|ejemplares|ejemplar|uds?)\b/i,
      /(?:necesitamos|necesito|queremos|quiero|buscamos|busco|compramos|solicitamos|pedimos|quiero pedir|queremos pedir)\s+(?:de\s+)?(\d[\d.]*)/i,
      /(?:cantidad|pedido)\s*(?:de|:)?\s*(\d[\d.]*)/i
    ],
    deadlinePatterns: [
      /(\d{1,3})\s*d[íi]as?\b/i,
      /(?:plazo|dentro de|en)\s+(?:de\s+)?(\d{1,3})\s*d[íi]as?\b/i
    ],
    destPatterns: [
      /puerto\s+de\s+([A-Za-zÀ-ÿ]+(?:\s+(?:de\s+)?[A-Za-zÀ-ÿ]+)?)/i,
      /(?:entrega|env[íi]o|destino)\s+(?:en|a|al)\s+(?:el\s+)?(?:puerto\s+de\s+)?([A-Za-zÀ-ÿ]+(?:\s+[A-Za-zÀ-ÿ]+)?)/i
    ],
    namePatterns: [
      /(?:necesitamos|necesito|queremos|quiero\s+pedir|queremos\s+pedir|quiero|buscamos|busco|compramos|nos\s+interesa|me\s+interesa)\s+(?:\d[\d.,]*\s+(?:unidades|piezas|uds?|ejemplares)\s+(?:de|del)\s+)?(.{3,60})/i
    ],
    priceWords: {
      competitor: /otro\s+proveedor|otros\s+proveedores|la\s+competencia/,
      ourQuote: /su\s+precio|vuestro\s+precio|precio\s+de\s+ustedes/,
      tooHigh: /demasiado\s+(caro|alto)|muy\s+caro/,
      budget: /presupuesto/,
      target: /precio\s+objetivo|precio\s+meta|podemos\s+pagar|nuestro\s+precio/
    },
    certCtx: {
      notRequired: /no\s+(?:es\s+)?(?:necesario|obligatorio|requerido)|no\s+se\s+requiere|opcional|sin\s+necesidad/,
      inquiry: /¿|pueden|puede\s+usted|podr[íi]an|tienen|disponen\s+de|es\s+posible/,
      mandatory: /se\s+requiere|es\s+obligatorio|obligatorio|requerido|debe\s+(?:tener|cumplir)|es\s+necesario|exigido/,
      preference: /preferible|preferimos|si\s+es\s+posible|idealmente/
    },
    signals: [
      { key: 'quote', label: '明确要求报价（西语）', pts: 10, re: /\b(cotizaci[óo]n|mejor\s+precio|su\s+precio)\b/i },
      { key: 'order', label: '明确采购/下单意向（西语）', pts: 10, re: /\b(hacer|realizar)\s+un\s+pedido\b|\bpedido\b|\bcomprar\b/i },
      { key: 'sample', label: '索要样品（西语）', pts: 6, re: /\bmuestras?\b/i },
      { key: 'terms', label: '询问付款/合同细节（西语）', pts: 5, re: /\b(condiciones|plazo|forma)\s+de\s+pago\b|\banticipo\b/i },
      { key: 'urgent', label: '时间紧迫（西语）', pts: 4, re: /\burgente\b|\blo\s+antes\s+posible\b|\bcuanto\s+antes\b/i },
      { key: 'details', label: '索要目录/详细资料（西语）', pts: 3, re: /\bcat[áa]logo\b|\bm[áa]s\s+detalles\b|\bespecificaciones\s+detalladas\b/i }
    ],
    typeWords: [
      [/receptores?\b/i, 'rx'], [/c[áa]maras?\b/i, 'camera'],
      [/bater[íi]as?\b/i, 'batt'], [/antenas?\b/i, 'ant'],
      [/cargadores?\b/i, 'charger'], [/motores?\b/i, 'motor'],
      [/gafas?\b/i, 'goggle'], [/servos?\b/i, 'servo']
    ]
  };

  /* ================= 法语 pack ================= */
  var FR = {
    code: 'fr',
    qtyPatterns: [
      /(\d[\d.]*)\s*(pi[èe]ces?|unit[ée]s?|exemplaires?)\b/i,
      /(?:avons\s+besoin\s+de|besoin\s+de|je\s+veux|nous\s+voulons|je\s+cherche|nous\s+cherchons|je\s+recherche|nous\s+recherchons)\s+(?:de\s+|d')?(\d[\d.]*)/i,
      /(?:quantit[ée])\s*(?:de|:)?\s*(\d[\d.]*)/i
    ],
    deadlinePatterns: [
      /(\d{1,3})\s*jours?\b/i,
      /(?:d[ée]lai|sous|dans)\s+(?:de\s+)?(\d{1,3})\s*jours?\b/i
    ],
    destPatterns: [
      /port\s+de\s+([A-Za-zÀ-ÿ]+(?:\s+[A-Za-zÀ-ÿ]+)?)/i,
      /(?:livraison|destination)\s+(?:au|à)\s+(?:le\s+)?(?:port\s+de\s+)?([A-Za-zÀ-ÿ]+(?:\s+[A-Za-zÀ-ÿ]+)?)/i
    ],
    namePatterns: [
      /(?:nous\s+avons\s+besoin\s+de|avons\s+besoin\s+de|je\s+cherche|nous\s+cherchons|je\s+recherche|nous\s+recherchons|je\s+veux|nous\s+voulons)\s+(?:\d[\d.,]*\s+(?:pi[èe]ces?|unit[ée]s?)\s+(?:de|du|des|d')\s*)?(.{3,60})/i
    ],
    priceWords: {
      competitor: /autre\s+fournisseur|concurrent|vos\s+concurrents/,
      ourQuote: /votre\s+prix/,
      tooHigh: /trop\s+cher|trop\s+[ée]lev[ée]/,
      budget: /budget/,
      target: /prix\s+cible|prix\s+objectif|notre\s+prix/
    },
    certCtx: {
      notRequired: /pas\s+obligatoire|non\s+requis|pas\s+n[ée]cessaire|optionnel|facultatif/,
      inquiry: /pouvez-vous|avez-vous|est-il|est-ce|disposez-vous/,
      mandatory: /est\s+exig[ée]|obligatoire|requis|doit\s+(?:avoir|être)|est\s+n[ée]cessaire|exig[ée]/,
      preference: /pr[ée]f[ée]rable|si\s+possible|id[ée]alement/
    },
    signals: [
      { key: 'quote', label: '明确要求报价（法语）', pts: 10, re: /\b(devis|cotisation|meilleur\s+prix|votre\s+prix|prix\s+cible)\b/i },
      { key: 'order', label: '明确采购/下单意向（法语）', pts: 10, re: /\bcommande\b|\bcommander\b|\bpasser\s+une\s+commande\b/i },
      { key: 'sample', label: '索要样品（法语）', pts: 6, re: /\b[ée]chantillons?\b/i },
      { key: 'terms', label: '询问付款/合同细节（法语）', pts: 5, re: /\bconditions\s+de\s+paiement\b|\bmodalit[ée]s\s+de\s+paiement\b|\bacompte\b/i },
      { key: 'urgent', label: '时间紧迫（法语）', pts: 4, re: /\burgent\b|\bau\s+plus\s+t[ôo]t\b|\bd[èe]s\s+que\s+possible\b/i },
      { key: 'details', label: '索要目录/详细资料（法语）', pts: 3, re: /\bcatalogue\b|\bplus\s+de\s+d[ée]tails\b|\bsp[ée]cifications\s+d[ée]taill[ée]es\b/i }
    ],
    typeWords: [
      [/r[ée]cepteurs?\b/i, 'rx'], [/cam[ée]ras?\b/i, 'camera'],
      [/batteries?\b/i, 'batt'], [/antennes?\b/i, 'ant'],
      [/chargeurs?\b/i, 'charger'], [/moteurs?\b/i, 'motor'],
      [/lunettes?\b/i, 'goggle'], [/servos?\b/i, 'servo']
    ]
  };

  /* ================= 德语 pack ================= */
  var DE = {
    code: 'de',
    qtyPatterns: [
      /(\d[\d.]*)\s*(Stück|Einheiten|Einheit|Teile|Exemplare)\b/i,
      /(?:wir\s+benötigen|benötigen|wir\s+brauchen|brauchen|ich\s+benötige|ich\s+brauche)\s+(?:von\s+)?(\d[\d.]*)/i,
      /(?:Menge|Anzahl|Bestellmenge)\s*(?:von|:)?\s*(\d[\d.]*)/i
    ],
    deadlinePatterns: [
      /(\d{1,3})\s*Tagen?\b/i,
      /(?:innerhalb\s+von|Lieferzeit(?:\s+von)?|binnen)\s*(\d{1,3})\s*Tagen?/i
    ],
    destPatterns: [
      /(?:nach|an)\s+(?:den\s+|die\s+|das\s+)?Hafen\s+([A-ZÄÖÜ][A-Za-zÀ-ÿ]+(?:\s[A-ZÄÖÜ][A-Za-zÀ-ÿ]+)?)/,
      /Hafen\s+([A-ZÄÖÜ][A-Za-zÀ-ÿ]+(?:\s[A-ZÄÖÜ][A-Za-zÀ-ÿ]+)?)/,
      /(?:Lieferung|Versand|Zielhafen)\s+(?:nach|an|in)\s+(?:den\s+)?(?:Hafen\s+)?([A-ZÄÖÜ][A-Za-zÀ-ÿ]+(?:\s[A-ZÄÖÜ][A-Za-zÀ-ÿ]+)?)/
    ],
    namePatterns: [
      /(?:wir\s+benötigen|benötigen|wir\s+brauchen|brauchen|ich\s+benötige|ich\s+brauche|wir\s+suchen|suchen)\s+(?:\d[\d.,]*\s+(?:Stück|Einheiten|Teile)\s+(?:des|der|den|dem|von)?\s*)?(.{3,60})/i
    ],
    priceWords: {
      competitor: /anderer\s+anbieter|anderer\s+lieferant|wettbewerber/,
      ourQuote: /ihr\s+preis|ihr\s+angebot/,
      tooHigh: /zu\s+teuer|zu\s+hoch/,
      budget: /budget/,
      target: /zielpreis|unser\s+preis/
    },
    certCtx: {
      notRequired: /nicht\s+erforderlich|nicht\s+notwendig|nicht\s+benötigt|optional/,
      inquiry: /können\s+sie|kann\s+ich|haben\s+sie|ist\s+es\s+möglich/,
      mandatory: /ist\s+erforderlich|erforderlich|wird\s+benötigt|benötigt|zwingend|muss\s+vorhanden/,
      preference: /bevorzugt|wenn\s+möglich|idealerweise/
    },
    signals: [
      { key: 'quote', label: '明确要求报价（德语）', pts: 10, re: /\b(angebot|bestes\s+angebot|ihr\s+preis|preisangebot)\b/i },
      { key: 'order', label: '明确采购/下单意向（德语）', pts: 10, re: /\b(bestellung|bestellen|auftrag)\b/i },
      { key: 'sample', label: '索要样品（德语）', pts: 6, re: /\bmuster\b/i },
      { key: 'terms', label: '询问付款/合同细节（德语）', pts: 5, re: /\b(zahlungsbedingungen|zahlungsziel|anzahlung)\b/i },
      { key: 'urgent', label: '时间紧迫（德语）', pts: 4, re: /\b(dringend|eilig|so\s+schnell\s+wie\s+m[öo]glich)\b/i },
      { key: 'details', label: '索要目录/详细资料（德语）', pts: 3, re: /\b(katalog|mehr\s+details|technische\s+daten)\b/i }
    ],
    typeWords: [
      [/empf[äa]nger/i, 'rx'], [/kamera/i, 'camera'], [/batterie|akku/i, 'batt'],
      [/antenne/i, 'ant'], [/ladeger[äa]t/i, 'charger'], [/motor/i, 'motor'], [/brille/i, 'goggle']
    ]
  };

  /* ================= 阿拉伯语 pack =================
     数字先经 parser 的 fold() 归一（阿拉伯-印度数字 → ASCII）再命中本包；
     分词无阿拉伯通道，名称维度仍靠型号等拉丁 token，品类走 typeWords。 */
  var AR = {
    code: 'ar',
    qtyPatterns: [
      /(\d[\d.]*)\s*(قطعة|قطع|وحدة|وحدات|حبة|حبات)/,
      /(?:نحتاج|نريد|نطلب)(?:\s+إلى)?\s+(\d[\d.]*)/,
      /(?:الكمية|عدد)\s*(?:هي|:)?\s*(\d[\d.]*)/
    ],
    deadlinePatterns: [
      /(\d{1,3})\s*(يوم|أيام|يوماً|يومًا)/,
      /(?:خلال|في\s+غضون|مدة)\s*(\d{1,3})\s*(يوم|أيام|يوماً|يومًا)/
    ],
    destPatterns: [
      /ميناء\s+([^\s,،.؟?]+(?:\s[^\s,،.؟?]+)?)/,
      /(?:التسليم|الشحن|الوجهة)\s+إلى\s+(?:ميناء\s+)?([^\s,،.؟?]+(?:\s[^\s,،.؟?]+)?)/
    ],
    namePatterns: [
      /(?:نحتاج|نريد|نطلب)(?:\s+إلى)?\s+(?:\d[\d.]*\s+(?:قطعة|قطع|وحدة|وحدات)\s+(?:من\s+)?)?(.{3,60})/
    ],
    priceWords: {
      competitor: /مورد\s+آخر|مورّد\s+آخر|المنافس/,
      ourQuote: /سعركم|السعر\s+الخاص\s+بكم/,
      tooHigh: /مرتفع\s+جداً|مرتفع\s+جدًا|غالي\s+جداً|غالي\s+جدًا/,
      budget: /الميزانية|ميزانيتنا/,
      target: /السعر\s+المستهدف|سعرنا\s+المستهدف/
    },
    certCtx: {
      notRequired: /غير\s+مطلوب|غير\s+إلزامي|اختياري/,
      inquiry: /هل|يمكنكم|هل\s+يمكن/,
      mandatory: /مطلوب|إلزامي|يجب|ضروري/,
      preference: /يفضل|يُفضّل|إن\s+أمكن/
    },
    signals: [
      { key: 'quote', label: '明确要求报价（阿语）', pts: 10, re: /أفضل\s+سعر|عرض\s+سعر|إرسال\s+السعر|أرسلوا\s+السعر/ },
      { key: 'order', label: '明确采购/下单意向（阿语）', pts: 10, re: /طلب\s+شراء|نريد\s+شراء|نطلب/ },
      { key: 'sample', label: '索要样品（阿语）', pts: 6, re: /عينة|عينات/ },
      { key: 'terms', label: '询问付款/合同细节（阿语）', pts: 5, re: /شروط\s+الدفع|دفعة\s+مقدمة/ },
      { key: 'urgent', label: '时间紧迫（阿语）', pts: 4, re: /عاجل|في\s+أقرب\s+وقت/ },
      { key: 'details', label: '索要目录/详细资料（阿语）', pts: 3, re: /كتالوج|تفاصيل|مواصفات\s+تفصيلية/ }
    ],
    typeWords: [
      [/جهاز\s+استقبال|مستقبل|استقبال/, 'rx'], [/كاميرا/, 'camera'], [/بطارية/, 'batt'],
      [/محرك/, 'motor'], [/هوائي/, 'ant'], [/شاحن/, 'charger']
    ]
  };

  /* ================= 印地语 pack（天城文） =================
     数字同样经 fold() 归一（天城文数字 → ASCII）。 */
  var HI = {
    code: 'hi',
    qtyPatterns: [
      /(\d[\d.]*)\s*(पीस|नग|यूनिट|टुकड़े|इकाइयाँ)/,
      /(?:हमें\s+चाहिए|चाहिए|हमें)\s*(\d[\d.]*)/,
      /(?:मात्रा|क्वांटिटी)\s*(?::|है)?\s*(\d[\d.]*)/
    ],
    deadlinePatterns: [
      /(\d{1,3})\s*(दिन|दिनों)/,
      /(\d{1,3})\s*दिनों?\s*के\s*अंदर/
    ],
    destPatterns: [
      /([^\s,।]+)\s+बंदरगाह/,
      /(?:डिलीवरी|भेजना|गंतव्य)\s+(?:को\s+)?([^\s,।]+)\s+बंदरगाह/
    ],
    namePatterns: [
      /(?:हमें|मुझे)\s+(?:\d[\d.]*\s+(?:पीस|नग)\s+)?(.{3,60}?)(?:\s+चाहिए|।|,|$)/
    ],
    priceWords: {
      competitor: /दूसरा\s+आपूर्तिकर्ता|अन्य\s+आपूर्तिकर्ता|प्रतियोगी/,
      ourQuote: /आपकी\s+कीमत|आपका\s+मूल्य/,
      tooHigh: /बहुत\s+महंगा|बहुत\s+ज़्यादा/,
      budget: /बजट/,
      target: /लक्षित\s+मूल्य|हमारा\s+मूल्य|लक्ष्य\s+मूल्य/
    },
    certCtx: {
      notRequired: /आवश्यक\s+नहीं|अनिवार्य\s+नहीं|वैकल्पिक/,
      inquiry: /क्या|क्या\s+आप/,
      mandatory: /आवश्यक|अनिवार्य|ज़रूरी/,
      preference: /अधिमानतः|यदि\s+संभव/
    },
    signals: [
      { key: 'quote', label: '明确要求报价（印地语）', pts: 10, re: /सर्वोत्तम\s+मूल्य|कोटेशन|कीमत\s+भेजें|मूल्य\s+भेजें/ },
      { key: 'order', label: '明确采购/下单意向（印地语）', pts: 10, re: /ऑर्डर|आदेश\s+देना|खरीदना/ },
      { key: 'sample', label: '索要样品（印地语）', pts: 6, re: /नमूना|सैंपल/ },
      { key: 'terms', label: '询问付款/合同细节（印地语）', pts: 5, re: /भुगतान\s+की\s+शर्तें|अग्रिम\s+भुगतान/ },
      { key: 'urgent', label: '时间紧迫（印地语）', pts: 4, re: /तत्काल|जल्दी|अर्जेंट|शीघ्र/ },
      { key: 'details', label: '索要目录/详细资料（印地语）', pts: 3, re: /कैटलॉग|विवरण|विस्तृत\s+जानकारी/ }
    ],
    typeWords: [
      [/रिसीवर/, 'rx'], [/कैमरा/, 'camera'], [/बैटरी/, 'batt'],
      [/मोटर/, 'motor'], [/एंटीना/, 'ant'], [/चार्जर/, 'charger']
    ]
  };

  /* ================= 葡萄牙语 pack（巴西为阿里国际站大买家市场） ================= */
  var PT = {
    code: 'pt',
    qtyPatterns: [
      /(\d[\d.,]*)\s*(unidades|unidade|peças|peça|pecas|peca)\b/i,
      /(?:precisamos|queremos|necessitamos)\s+(?:de\s+)?(\d[\d.,]*)/i
    ],
    deadlinePatterns: [
      /(\d{1,3})\s*dias?\b/i,
      /(?:prazo|entrega)[^.\d]{0,24}(\d{1,3})\s*dias?/i
    ],
    destPatterns: [
      /(?:porto)\s+(?:de|do|da)\s+([A-ZÀ-Þ][\wÀ-ÿ]+(?:\s[A-ZÀ-Þ][\wÀ-ÿ]+)?)/,
      /(?:entrega|destino|envio)\s+(?:de|em|para)\s+(?:o\s+|a\s+)?([A-ZÀ-Þ][\wÀ-ÿ]+(?:\s(?:de|do|da)\s[\wÀ-ÿ]+|\s[A-ZÀ-Þ][\wÀ-ÿ]+)?)/,
      /(?:para|em)\s+(?:o\s+porto\s+de\s+)?([A-ZÀ-Þ][\wÀ-ÿ]+(?:\s[A-ZÀ-Þ][\wÀ-ÿ]+)?)/
    ],
    namePatterns: [
      /(?:precisamos|queremos|necessitamos|comprar)(?:\s+de)?\s+(?:\d[\d.,]*\s+(?:unidades|unidade|peças|peça)\s+(?:de|do|da|dos|das)?\s*)?(.{3,60})/i
    ],
    priceWords: {
      competitor: /concorrente|outro\s+(?:fornecedor|vendedor)/,
      ourQuote: /(?:seu|o\s+seu)\s+pre[çc]o/,
      tooHigh: /muito\s+(?:caro|alto)|acima\s+do/,
      budget: /or[çc]amento/,
      target: /pre[çc]o[\s-]*(?:alvo|objetivo|meta)|pre[çc]o\s+desejado/
    },
    certCtx: {
      notRequired: /n[ãa]o\s+(?:[ée]\s+)?(?:necess[áa]rio|obrigat[óo]rio)|sem\s+(?:certificado|certifica[çc][ãa]o)\s+CE|n[ãa]o\s+precisamos\s+(?:de\s+)?(?:certificado\s+)?CE/i,
      inquiry: /voc[êe]s\s+(?:t[êe]m|possuem)|(?:possui|tem)\s+(?:certificado|certifica[çc][ãa]o)\s+CE|certifica[çc][ãa]o\s+CE\s*\?/i,
      mandatory: /(?:certificado|certifica[çc][ãa]o)\s+CE\s+(?:[ée]\s+)?(?:obrigat[óo]rio|necess[áa]rio|exigido)|CE\s+obrigat[óo]rio/i,
      preference: /prefer[íi]vel|de\s+prefer[êe]ncia/i
    },
    signals: [
      { key: 'quote', label: '明确要求报价（葡语）', pts: 10, re: /\b(envie|cota[çc][ãa]o|melhor\s+pre[çc]o|seu\s+pre[çc]o|nos\s+envie)\b/i },
      { key: 'order', label: '明确采购/下单意向（葡语）', pts: 10, re: /\b(pedido|comprar|encomenda)\b/i },
      { key: 'sample', label: '索要样品（葡语）', pts: 6, re: /\bamostra\b/i },
      { key: 'terms', label: '询问付款/合同细节（葡语）', pts: 5, re: /\b(condi[çc][õo]es\s+de\s+pagamento|pagamento|prazo\s+de\s+pagamento)\b/i },
      { key: 'urgent', label: '时间紧迫（葡语）', pts: 4, re: /\b(urgente|urg[êe]ncia)\b/i },
      { key: 'details', label: '索要目录/详细资料（葡语）', pts: 3, re: /\b(cat[áa]logo|detalhes|especifica[çc][õo]es)\b/i }
    ],
    typeWords: [
      [/receptor/, 'rx'], [/transmissor/, 'tx'], [/c[âa]mera/, 'camera'],
      [/antena/, 'ant'], [/motor/, 'motor'], [/bateria/, 'batt'], [/carregador/, 'charger']
    ]
  };

  /* ================= 俄语 pack（西里尔字母；匹配靠型号/规格/品类，护栏按覆盖度放行） ================= */
  var RU = {
    code: 'ru',
    qtyPatterns: [
      /(\d[\d.,]*)\s*(шт\.?|штук|штуки|единиц|единицы)/i,
      /(?:нужно|нужны|нужен|нужна|требуется|необходимо)\s+(\d[\d.,]*)/i
    ],
    deadlinePatterns: [
      /(?:в\s+течение|за)\s+(\d{1,3})\s*(?:дней|дня|день)/i,
      /срок[^.\d]{0,24}(\d{1,3})\s*(?:дней|дня)/i,
      /(\d{1,3})\s*(?:дней|дня|день)\b/i
    ],
    destPatterns: [
      /порт[а-яё\s]{0,12}?([А-ЯЁ][а-яё]+(?:\s[А-ЯЁ][а-яё]+)?)/,
      /(?:доставка|отправка|поставка)\s+(?:в\s+|до\s+)?(?:порт\s+)?([А-ЯЁ][а-яё]+(?:\s[А-ЯЁ][а-яё]+)?)/
    ],
    namePatterns: [
      /(?:нам\s+)?(?:нужно|нужны|нужен|нужна|требуется|необходимо|интересует|интересуют)\s+(?:\d[\d.,]*\s+(?:шт\.?|штук|единиц)\s+)?(.{3,60})/i
    ],
    priceWords: {
      competitor: /конкурент|другой\s+(?:поставщик|продавец)/,
      ourQuote: /ваша\s+цена|ваш[а-яё]*\s+цен/,
      tooHigh: /слишком\s+(?:дорого|высокая|высокий)|дороговато/,
      budget: /бюджет/,
      target: /целевая\s+цена|целевой\s+цен|наша\s+цена/
    },
    certCtx: {
      notRequired: /CE\s+не\s+(?:требуется|нужен|нужна)|без\s+(?:сертификата\s+)?CE/i,
      inquiry: /(?:есть\s+ли|имеется\s+ли|наличие)\s+(?:сертификат\s+)?CE|сертификат\s+CE\s*\?/i,
      mandatory: /(?:сертификат\s+)?CE\s+(?:обязательно|обязателен|требуется)|обязательн/i,
      preference: /желательно|предпочтительно/i
    },
    signals: [
      { key: 'quote', label: '明确要求报价（俄语）', pts: 10, re: /пришлите|отправьте|коммерческое\s+предложение|вашу\s+цену|лучшую\s+цену|предложени[яею]/i },
      { key: 'order', label: '明确采购/下单意向（俄语）', pts: 10, re: /заказ|заказать|закупить/i },
      { key: 'sample', label: '询问样品（俄语）', pts: 8, re: /образ(ец|цы|цов)/i },
      { key: 'terms', label: '询问付款/合同细节（俄语）', pts: 5, re: /условия\s+оплаты|предоплата/i },
      { key: 'urgent', label: '交期紧急（俄语）', pts: 6, re: /срочно|срочная|срочный/i },
      { key: 'details', label: '索要目录/详细资料（俄语）', pts: 3, re: /каталог|характеристики|подробн/i }
    ],
    typeWords: [
      [/при[её]мник/, 'rx'], [/передатчик/, 'tx'], [/камер/, 'camera'],
      [/антенн/, 'ant'], [/мотор|двигател/, 'motor'], [/батаре|аккумулятор/, 'batt'], [/зарядн/, 'charger']
    ]
  };

  /* ================= 土耳其语 pack（土耳其为阿里国际站重要买家市场） ================= */
  var TR = {
    code: 'tr',
    qtyPatterns: [
      /(\d[\d.,]*)\s*(adet|tane|parça)\b/i,
      /(?:ihtiyacımız|ihtiyaç|istiyoruz|arıyoruz)[^.\d]{0,16}(\d[\d.,]*)/i
    ],
    deadlinePatterns: [
      /(\d{1,3})\s*gün\s*(?:içinde|içerisinde)/i,
      /(?:teslim\s*süresi|teslimat)[^.\d]{0,20}(\d{1,3})\s*gün/i,
      /(\d{1,3})\s*gün\b/i
    ],
    destPatterns: [
      /([A-ZÇĞİÖŞÜ][\wçğıöşü]+)\s+liman/i,
      /(?:teslim|varış)\s*(?:yeri\s*)?:?\s*([A-ZÇĞİÖŞÜ][\wçğıöşü]+(?:\s[A-ZÇĞİÖŞÜ][\wçğıöşü]+)?)/
    ],
    namePatterns: [
      /(?:\d[\d.,]*)\s*(?:adet|tane)\s+(.{3,60})/i,
      /(?:ihtiyacımız\s+(?:olan\s+)?|aradığımız|istediğimiz|ihtiyaç\s+duyduğumuz)\s+(?:\d[\d.,]*\s+(?:adet|tane)\s+)?(.{3,60})/i
    ],
    priceWords: {
      competitor: /rakip|başka\s+(?:bir\s+)?(?:tedarikçi|satıcı)/,
      ourQuote: /sizin\s+fiyat|fiyatınız|teklifiniz/,
      tooHigh: /çok\s+(?:pahalı|yüksek)/,
      budget: /bütçe/,
      target: /hedef\s+fiyat/
    },
    certCtx: {
      notRequired: /CE\s+(?:gerekli\s+değil|şart\s+değil|istenmiyor)|CE\s+(?:belgesi\s+)?gerekmez/i,
      inquiry: /CE\s+(?:belgeniz|sertifikanız)\s+var\s+mı|CE\s+(?:belgesi|sertifikası)\s+(?:var\s+mı|mevcut\s+mu)/i,
      mandatory: /CE\s+(?:belgesi\s+)?(?:gerekli|zorunlu|şart)|CE\s+zorunlu/i,
      preference: /tercihen|tercih\s+edilir/i
    },
    signals: [
      { key: 'quote', label: '明确要求报价（土语）', pts: 10, re: /fiyat\s+teklif|teklifinizi|en\s+iyi\s+fiyat/i },
      { key: 'order', label: '明确采购/下单意向（土语）', pts: 10, re: /sipariş|satın\s+almak/i },
      { key: 'sample', label: '索要样品（土语）', pts: 6, re: /numune/i },
      { key: 'terms', label: '询问付款/合同细节（土语）', pts: 5, re: /ödeme\s+(?:koşulları|şartları)|peşinat/i },
      { key: 'urgent', label: '时间紧迫（土语）', pts: 4, re: /acil/i },
      { key: 'details', label: '索要目录/详细资料（土语）', pts: 3, re: /katalog|detaylar|özellikler/i }
    ],
    typeWords: [
      [/alıcı/, 'rx'], [/verici/, 'tx'], [/kamera/, 'camera'],
      [/anten/, 'ant'], [/motor/, 'motor'], [/pil|batarya/, 'batt'], [/şarj/, 'charger']
    ]
  };

  /* ================= 印尼语 pack（印尼为东南亚大买家市场） ================= */
  var IDP = {
    code: 'id',
    qtyPatterns: [
      /(\d[\d.,]*)\s*(unit|buah|pcs|potong)\b/i,
      /(?:membutuhkan|butuh|mencari|memerlukan)\s+(\d[\d.,]*)/i
    ],
    deadlinePatterns: [
      /(?:dalam|selama)\s+(\d{1,3})\s+hari/i,
      /(\d{1,3})\s+hari\b/i,
      /(?:waktu\s+pengiriman|lead\s*time)[^.\d]{0,20}(\d{1,3})\s+hari/i
    ],
    destPatterns: [
      /pelabuhan\s+(?:di\s+)?([A-Z][\w]+(?:\s[A-Z][\w]+)?)/,
      /(?:pengiriman|dikirim)\s+ke\s+(?:pelabuhan\s+)?([A-Z][\w]+(?:\s[A-Z][\w]+)?)/
    ],
    namePatterns: [
      /(?:membutuhkan|kami\s+butuh|butuh|mencari|memerlukan)\s+(?:\d[\d.,]*\s+(?:unit|buah|pcs)\s+)?(.{3,60})/i
    ],
    priceWords: {
      competitor: /pesaing|pemasok\s+lain|supplier\s+lain/,
      ourQuote: /harga\s+(?:Anda|anda|kalian)/,
      tooHigh: /terlalu\s+(?:mahal|tinggi)/,
      budget: /anggaran|budget/,
      target: /harga\s+(?:target|sasaran)/
    },
    certCtx: {
      notRequired: /CE\s+tidak\s+(?:diperlukan|wajib|perlu)|tanpa\s+(?:sertifikat\s+)?CE/i,
      inquiry: /apakah[^.]{0,40}CE|(?:memiliki|punya)\s+sertifikat\s+CE/i,
      mandatory: /(?:sertifikat\s+)?CE\s+(?:wajib|diperlukan|harus)|wajib\s+CE/i,
      preference: /diutamakan|lebih\s+baik/i
    },
    signals: [
      { key: 'quote', label: '明确要求报价（印尼语）', pts: 10, re: /penawaran|harga\s+terbaik|kirimkan\s+harga/i },
      { key: 'order', label: '明确采购/下单意向（印尼语）', pts: 10, re: /\b(pesan|pemesanan|membeli)\b/i },
      { key: 'sample', label: '索要样品（印尼语）', pts: 6, re: /\b(sampel|contoh)\b/i },
      { key: 'terms', label: '询问付款/合同细节（印尼语）', pts: 5, re: /syarat\s+pembayaran|uang\s+muka/i },
      { key: 'urgent', label: '时间紧迫（印尼语）', pts: 4, re: /mendesak|segera/i },
      { key: 'details', label: '索要目录/详细资料（印尼语）', pts: 3, re: /katalog|detail|spesifikasi/i }
    ],
    typeWords: [
      [/penerima/, 'rx'], [/pemancar/, 'tx'], [/kamera/, 'camera'],
      [/antena/, 'ant'], [/motor/, 'motor'], [/baterai/, 'batt'], [/pengisi\s+daya/, 'charger']
    ]
  };

  /* ================= 回复句库（P1-5-REPLY） =================
     只负责表达，不负责计算：每句与 ReplyAssistant 英文模板逐句对应，
     槽位 {x} 由生成器用已过护栏的事实填充。缺句即整稿降级英文，
     不拼混合语言稿。fr/de/ar/hi/tr/id 暂未配句库（reply 缺省）。 */
  ES.reply = {
    greetWith: 'Hola, {name},', greetPlain: 'Hola,', sign: '\n\nSaludos cordiales,\n{seller}',
    askTpl: '- ¿Podría confirmar {item}?',
    ask_qty: 'la cantidad que necesita', ask_product: 'el modelo exacto que busca',
    ask_dest: 'el puerto o país de destino', ask_lead: 'el plazo de entrega que espera',
    ask_purpose: 'el uso que dará a los productos',
    clarifyThanks: 'Gracias por su consulta{about}.', clarifyAbout: ' sobre {name}',
    clarifyIntro: 'Antes de cotizar, quiero verificar algunos puntos, porque parte de su requerimiento no coincide con los datos del producto que tengo a mano:',
    clarifyAsk: '¿Podría confirmar el requerimiento exacto en estos puntos? Una vez confirmado, volveré con el producto correcto y una cotización precisa.',
    negThanks: 'Gracias por compartir su precio objetivo de {target} para {product}.', negProduct: 'el producto',
    negChecking: 'Estoy revisando el costo según su cantidad y le confirmaré en breve nuestro mejor precio posible. Por favor, no lo tome todavía como una aceptación de su precio objetivo: quiero darle una cifra firme que realmente podamos cumplir.',
    negCloseOk: 'Su precio objetivo está cerca de un nivel viable para nosotros. Lo confirmaré internamente junto con las condiciones finales y le enviaré una cotización formal para su aprobación.',
    negBestIs: 'Nuestro mejor precio actual es de {unit} por unidad, según las especificaciones registradas{certPart}.',
    negCertPart: ' y las certificaciones ({certs})',
    negLevers: 'Para acercarnos a su precio objetivo, las palancas realistas son una cantidad mayor o plazos de entrega más flexibles. Si puede ajustar alguno de los dos, volveré a revisar el precio para usted de inmediato.',
    negBelowCost: 'Lo revisé con cuidado y debo ser honesto: {target} está por debajo de nuestro costo de producción para esta especificación, por lo que no puedo aceptarlo sin cambiar el propio producto.',
    negBelowFloor: 'Lo revisé con cuidado y debo ser honesto: {target} está por debajo del precio más bajo que podemos aceptar para esta especificación, por lo que no puedo aceptarlo tal como está.',
    negBestOffer: 'Lo mejor que puedo ofrecerle para la especificación actual es {unit} por unidad.',
    negBestConfirm: 'Le confirmaré en breve nuestro mejor precio posible para la especificación actual.',
    negBudgetAlt: 'Si el presupuesto es fijo, podemos considerar ajustar la especificación o el embalaje para acercarnos: dígame qué le importa más, la especificación o el precio.',
    moqThanks: 'Gracias por su consulta sobre {ref}.',
    moqBody: 'Mencionó {qty} unidades. La cantidad mínima de pedido para este modelo es de {moq} unidades, principalmente por la preparación de producción y embalaje.',
    moqOptions: 'Algunas opciones: (1) aumentar a {moq} unidades para mantener el precio estándar; (2) empezar con muestras para comprobar la calidad primero; (3) si {qty} unidades es una cantidad firme, volveré a revisar qué precio podemos hacer para esa cantidad, sería algo más alto que el precio estándar.',
    moqAsk: '¿Qué opción le funciona mejor?',
    sampleThanks: 'Gracias por su consulta{about}. Podemos prepararle una muestra para que compruebe la calidad.',
    sampleAbout: ' sobre {ref}',
    sampleConfirm: 'Para prepararla correctamente, ¿podría confirmar:',
    sampleModel: '- El modelo exacto{mentioned};', sampleMentioned: ' (mencionó {models})',
    sampleQty: '- ¿Cuántas piezas de muestra necesita;',
    sampleAddr: '- Su dirección de entrega, para poder confirmarle el costo y el plazo de la muestra.',
    fuFirst: 'Solo quería dar seguimiento a mi mensaje anterior sobre {product}.',
    fuSample: 'Si le ayuda, podemos empezar con una muestra para que compruebe la calidad personalmente antes de decidir la cantidad.',
    fuSpec: 'O si algún punto de la especificación aún no está claro, dígame cuál y se lo confirmo.',
    specThanks: 'Gracias por preguntar sobre las especificaciones de {ref}.',
    specListed: 'Según lo registrado para este modelo: {specs}.',
    specChecking: 'Estoy confirmando internamente la hoja completa de especificaciones de este modelo y le compartiré solo los detalles verificados.',
    specCerts: 'Certificaciones registradas para este modelo: {certs}.',
    specMoq: 'Cantidad mínima de pedido: {moq} unidades.',
    specLead: 'Plazo de entrega estándar: aproximadamente {days} días.',
    specAsk: 'Si necesita confirmar algún parámetro específico (por ejemplo, un informe de prueba o un plano de dimensiones), dígame cuál y lo reviso por usted.',
    preThanks: 'Gracias por su consulta{about}{closest}.', preAbout: ' sobre {name}',
    preClosest: '; el modelo más cercano de nuestra gama es {ref}',
    preIntro: 'Para poder cotizar con precisión en lugar de hacer una estimación, ¿podría confirmar algunos puntos?',
    preDone: 'Una vez que tenga estos datos, le enviaré una cotización firme en lugar de una estimación aproximada.',
    firstThanks: 'Gracias por su consulta{about}.', firstAbout: ' sobre {ref}',
    knownSpec: 'Especificaciones registradas: {specs}.', knownCerts: 'Certificaciones registradas: {certs}.',
    knownMoq: 'Cantidad mínima de pedido: {moq} unidades.', knownLead: 'Plazo de entrega estándar: aproximadamente {days} días.',
    firstPrice: 'Para {qty} unidades, nuestro precio es de {unit} por unidad{incoterm}.',
    firstIncoterm: ' ({incoterm})', qtyQuoted: 'la cantidad consultada',
    firstFinalize: 'Para cerrar los detalles, ¿podría confirmar:',
    firstWillQuote: 'Le enviaré una cotización firme en cuanto finalice la verificación de costos de nuestro lado.',
    firstClosing: 'Quedo atento a su respuesta.'
  };
  PT.reply = {
    greetWith: 'Olá, {name},', greetPlain: 'Olá,', sign: '\n\nAtenciosamente,\n{seller}',
    askTpl: '- Poderia confirmar {item}?',
    ask_qty: 'a quantidade de que você precisa', ask_product: 'o modelo exato que você procura',
    ask_dest: 'o porto ou país de destino', ask_lead: 'o prazo de entrega que você espera',
    ask_purpose: 'o uso que será dado aos produtos',
    clarifyThanks: 'Obrigado pela sua consulta{about}.', clarifyAbout: ' sobre {name}',
    clarifyIntro: 'Antes de cotizar, quero verificar alguns pontos, porque parte da sua necessidade não coincide com os dados do produto que tenho em mãos:',
    clarifyAsk: 'Poderia confirmar a necessidade exata nesses pontos? Assim que confirmar, retorno com o produto correto e uma cotação precisa.',
    negThanks: 'Obrigado por compartilhar seu preço-alvo de {target} para {product}.', negProduct: 'o produto',
    negChecking: 'Estou verificando o custo com base na sua quantidade e confirmarei em breve nosso melhor preço possível. Por favor, ainda não considere isso uma aceitação do seu preço-alvo: quero lhe dar um número firme que realmente possamos cumprir.',
    negCloseOk: 'Seu preço-alvo está próximo de um nível viável para nós. Vou confirmá-lo internamente junto com as condições finais e enviarei uma cotação formal para sua aprovação.',
    negBestIs: 'Nosso melhor preço atual é de {unit} por unidade, com base nas especificações registradas{certPart}.',
    negCertPart: ' e certificações ({certs})',
    negLevers: 'Para nos aproximarmos do seu preço-alvo, as alavancas realistas são uma quantidade maior ou prazos de entrega mais flexíveis. Se você puder ajustar um dos dois, reviso o preço para você imediatamente.',
    negBelowCost: 'Verifiquei com cuidado e preciso ser honesto: {target} está abaixo do nosso custo de produção para esta especificação, portanto não posso aceitá-lo sem alterar o próprio produto.',
    negBelowFloor: 'Verifiquei com cuidado e preciso ser honesto: {target} está abaixo do menor preço que podemos aceitar para esta especificação, portanto não posso aceitá-lo como está.',
    negBestOffer: 'O melhor que posso oferecer pela especificação atual é {unit} por unidade.',
    negBestConfirm: 'Confirmarei em breve nosso melhor preço possível para a especificação atual.',
    negBudgetAlt: 'Se o orçamento for fixo, podemos considerar ajustar a especificação ou a embalagem para nos aproximarmos: diga-me o que importa mais para você, a especificação ou o preço.',
    moqThanks: 'Obrigado pela sua consulta sobre {ref}.',
    moqBody: 'Você mencionou {qty} unidades. A quantidade mínima de pedido para este modelo é de {moq} unidades, principalmente devido à preparação de produção e embalagem.',
    moqOptions: 'Algumas opções: (1) aumentar para {moq} unidades para manter o preço padrão; (2) começar com amostras para verificar a qualidade primeiro; (3) se {qty} unidades for uma quantidade firme, vou rever qual preço podemos fazer para essa quantidade, seria um pouco mais alto que o preço padrão.',
    moqAsk: 'Qual opção funciona melhor para você?',
    sampleThanks: 'Obrigado pela sua consulta{about}. Podemos providenciar uma amostra para você verificar a qualidade.',
    sampleAbout: ' sobre {ref}',
    sampleConfirm: 'Para prepará-la corretamente, poderia confirmar:',
    sampleModel: '- O modelo exato{mentioned};', sampleMentioned: ' (você mencionou {models})',
    sampleQty: '- Quantas peças de amostra você precisa;',
    sampleAddr: '- Seu endereço de entrega, para que eu possa confirmar o custo e o prazo da amostra para você.',
    fuFirst: 'Apenas acompanhando minha mensagem anterior sobre {product}.',
    fuSample: 'Se ajudar, podemos começar com uma amostra para você verificar a qualidade pessoalmente antes de decidir a quantidade.',
    fuSpec: 'Ou, se algum ponto da especificação ainda não estiver claro, diga-me qual e eu confirmo para você.',
    specThanks: 'Obrigado por perguntar sobre as especificações de {ref}.',
    specListed: 'Conforme registrado para este modelo: {specs}.',
    specChecking: 'Estou confirmando internamente a folha completa de especificações deste modelo e compartilharei apenas os detalhes verificados.',
    specCerts: 'Certificações registradas para este modelo: {certs}.',
    specMoq: 'Quantidade mínima de pedido: {moq} unidades.',
    specLead: 'Prazo de entrega padrão: aproximadamente {days} dias.',
    specAsk: 'Se você precisar confirmar algum parâmetro específico (por exemplo, um relatório de teste ou um desenho dimensional), diga-me qual e eu verifico para você.',
    preThanks: 'Obrigado pela sua consulta{about}{closest}.', preAbout: ' sobre {name}',
    preClosest: '; o modelo mais próximo da nossa linha é {ref}',
    preIntro: 'Para poder cotizar com precisão em vez de estimar, poderia confirmar alguns pontos?',
    preDone: 'Assim que tiver esses dados, enviarei uma cotação firme em vez de uma estimativa aproximada.',
    firstThanks: 'Obrigado pela sua consulta{about}.', firstAbout: ' sobre {ref}',
    knownSpec: 'Especificações registradas: {specs}.', knownCerts: 'Certificações registradas: {certs}.',
    knownMoq: 'Quantidade mínima de pedido: {moq} unidades.', knownLead: 'Prazo de entrega padrão: aproximadamente {days} dias.',
    firstPrice: 'Para {qty} unidades, nosso preço é de {unit} por unidade{incoterm}.',
    firstIncoterm: ' ({incoterm})', qtyQuoted: 'a quantidade consultada',
    firstFinalize: 'Para fechar os detalhes, poderia confirmar:',
    firstWillQuote: 'Enviarei uma cotação firme assim que a verificação final de custos for concluída do nosso lado.',
    firstClosing: 'Fico no aguardo da sua resposta.'
  };
  RU.reply = {
    greetWith: 'Добрый день, {name}!', greetPlain: 'Добрый день!', sign: '\n\nС уважением,\n{seller}',
    askTpl: '- Не могли бы вы подтвердить {item}?',
    ask_qty: 'нужное вам количество', ask_product: 'точную модель, которую вы ищете',
    ask_dest: 'порт или страну назначения', ask_lead: 'ожидаемый вами срок поставки',
    ask_purpose: 'для чего будут использоваться изделия',
    clarifyThanks: 'Спасибо за ваш запрос{about}.', clarifyAbout: ' по {name}',
    clarifyIntro: 'Прежде чем дать цену, я хочу уточнить несколько моментов, поскольку часть ваших требований не совпадает с данными о продукте, которые у меня есть:',
    clarifyAsk: 'Не могли бы вы подтвердить точные требования по этим пунктам? Как только подтвердите, я вернусь с правильным продуктом и точным коммерческим предложением.',
    negThanks: 'Спасибо, что сообщили вашу целевую цену {target} на {product}.', negProduct: 'продукт',
    negChecking: 'Сейчас я проверяю себестоимость исходя из вашего количества и вскоре подтвержу нашу лучшую возможную цену. Пожалуйста, пока не считайте это согласием на вашу целевую цену — я хочу дать вам твёрдую цифру, которую мы действительно сможем выдержать.',
    negCloseOk: 'Ваша целевая цена близка к уровню, с которым мы можем работать. Я подтвержу её внутри компании вместе с финальными условиями и отправлю вам официальное коммерческое предложение на согласование.',
    negBestIs: 'Наша текущая лучшая цена — {unit} за штуку, исходя из зарегистрированных характеристик{certPart}.',
    negCertPart: ' и сертификатов ({certs})',
    negLevers: 'Чтобы приблизиться к вашей целевой цене, реальные рычаги — больший объём заказа или более гибкие сроки поставки. Если вы сможете скорректировать что-то из этого, я сразу перепроверю цену для вас.',
    negBelowCost: 'Я внимательно всё проверил и должен честно сказать: {target} ниже себестоимости производства по этой спецификации, поэтому я не могу принять эту цену без изменения самого продукта.',
    negBelowFloor: 'Я внимательно всё проверил и должен честно сказать: {target} ниже самой низкой цены, которую мы можем принять по этой спецификации, поэтому я не могу подтвердить её в текущем виде.',
    negBestOffer: 'Лучшее, что я могу предложить по текущей спецификации, — {unit} за штуку.',
    negBestConfirm: 'Я вскоре подтвержу нашу лучшую возможную цену по текущей спецификации.',
    negBudgetAlt: 'Если бюджет фиксированный, мы можем рассмотреть корректировку спецификации или упаковки, чтобы приблизиться к нему: скажите, что для вас важнее, спецификация или цена.',
    moqThanks: 'Спасибо за ваш запрос о {ref}.',
    moqBody: 'Вы указали {qty} шт. Минимальное количество заказа для этой модели — {moq} шт., в основном из-за подготовки производства и упаковки.',
    moqOptions: 'Несколько вариантов: (1) увеличить до {moq} шт., чтобы сохранить стандартную цену; (2) начать с образцов, чтобы сначала проверить качество; (3) если {qty} шт. — твёрдое количество, я перепроверю, какую цену мы можем дать на этот объём, она будет немного выше стандартной.',
    moqAsk: 'Какой вариант вам подходит лучше?',
    sampleThanks: 'Спасибо за ваш запрос{about}. Мы можем подготовить для вас образец, чтобы вы проверили качество.',
    sampleAbout: ' о {ref}',
    sampleConfirm: 'Чтобы подготовить его правильно, не могли бы вы подтвердить:',
    sampleModel: '- Точную модель{mentioned};', sampleMentioned: ' (вы упоминали {models})',
    sampleQty: '- Сколько образцов вам нужно;',
    sampleAddr: '- Ваш адрес доставки, чтобы я мог подтвердить для вас стоимость и срок образца.',
    fuFirst: 'Хотел уточнить по моему предыдущему сообщению о {product}.',
    fuSample: 'Если это поможет, мы можем начать с образца, чтобы вы лично проверили качество, прежде чем решать по количеству.',
    fuSpec: 'Или, если какой-то пункт спецификации всё ещё неясен, скажите какой, и я подтвержу его для вас.',
    specThanks: 'Спасибо за вопрос о характеристиках {ref}.',
    specListed: 'Как зарегистрировано для этой модели: {specs}.',
    specChecking: 'Я уточняю внутри компании полную спецификацию этой модели и поделюсь только проверенными данными.',
    specCerts: 'Зарегистрированные сертификаты для этой модели: {certs}.',
    specMoq: 'Минимальное количество заказа: {moq} шт.',
    specLead: 'Стандартный срок поставки: около {days} дней.',
    specAsk: 'Если вам нужно подтвердить какой-то конкретный параметр (например, протокол испытаний или чертёж с размерами), скажите какой, и я проверю его для вас.',
    preThanks: 'Спасибо за ваш запрос{about}{closest}.', preAbout: ' о {name}',
    preClosest: '; ближайшая модель в нашей линейке — {ref}',
    preIntro: 'Чтобы дать точную цену, а не приблизительную оценку, не могли бы вы подтвердить несколько пунктов?',
    preDone: 'Как только получу эти данные, я отправлю вам твёрдое коммерческое предложение вместо приблизительной оценки.',
    firstThanks: 'Спасибо за ваш запрос{about}.', firstAbout: ' о {ref}',
    knownSpec: 'Зарегистрированные характеристики: {specs}.', knownCerts: 'Зарегистрированные сертификаты: {certs}.',
    knownMoq: 'Минимальное количество заказа: {moq} шт.', knownLead: 'Стандартный срок поставки: около {days} дней.',
    firstPrice: 'За {qty} шт. наша цена — {unit} за штуку{incoterm}.',
    firstIncoterm: ' ({incoterm})', qtyQuoted: 'запрошенное количество',
    firstFinalize: 'Чтобы уточнить финальные детали, не могли бы вы подтвердить:',
    firstWillQuote: 'Я отправлю вам твёрдое коммерческое предложение, как только с нашей стороны завершится финальная проверка себестоимости.',
    firstClosing: 'Жду вашего ответа.'
  };

  /* 已启用词汇包（顺序即后备优先级）。新增语言 = 新增同结构 pack 并登记。 */
  var PACKS = { es: ES, fr: FR, de: DE, ar: AR, hi: HI, pt: PT, ru: RU, tr: TR, id: IDP };
  var ENABLED = [ES, FR, DE, AR, HI, PT, RU, TR, IDP];

  /* 拉丁语系启发式识别（供 translate.detect 在文字系统判断之后兜底）：
     返回 'es' / 'fr' / ''（无法判断）。强标记优先，特征词需 ≥2 才认。 */
  function hintLatin(text) {
    var raw = String(text || '');
    if (/[ñ¿¡]/.test(raw)) return 'es';
    if (/[ãõ]/.test(raw)) return 'pt';
    if (/ß/.test(raw)) return 'de';
    var s = foldKey(raw);
    var esHits = (s.match(/\b(hola|gracias|necesitamos|necesito|queremos|precio|precios|entrega|puerto|unidades|piezas|por|favor|dias|envio|pedido|cantidad|nuestro|nuestra|certificado|para|con|del)\b/g) || []).length;
    var frHits = (s.match(/\b(bonjour|merci|nous|vous|prix|livraison|pieces|jours|veuillez|recepteur|besoin|commande|notre|votre|certificat|delai|pour|avec|dans)\b/g) || []).length;
    var deHits = (s.match(/\b(und|wir|sie|bitte|preis|angebot|lieferung|lieferzeit|stuck|tagen|benotigen|brauchen|empfanger|hafen|zielpreis|vielen|dank|grusse|ware|menge|tage)\b/g) || []).length;
    var ptHits = (s.match(/\b(ola|obrigado|obrigada|voces|preco|precos|orcamento|pecas|precisamos|queremos|cotacao|tambem|nao|entrega|unidades|com|em)\b/g) || []).length;
    var trHits = (s.match(/\b(ihtiyacimiz|teklif|teklifinizi|liman|limanina|adet|teslim|teslimat|fiyat|fiyatimiz|lutfen|belgesi|gun)\b/g) || []).length;
    var idHits = (s.match(/\b(kami|membutuhkan|harga|pengiriman|pelabuhan|apakah|kirimkan|penawaran|terima|kasih|butuh|memerlukan)\b/g) || []).length;
    var all = [['es', esHits], ['fr', frHits], ['de', deHits], ['pt', ptHits], ['tr', trHits], ['id', idHits]];
    all.sort(function (a, b) { return b[1] - a[1]; });
    if (/[ç]/.test(raw) && frHits >= 1 && frHits >= esHits && frHits >= deHits && frHits >= ptHits) return 'fr';
    if (/pre[çc]o|or[çc]amento|voc[êe]s/.test(raw.toLowerCase()) && ptHits >= 2 && ptHits >= esHits) return 'pt';
    if (all[0][1] >= 2 && all[0][1] > all[1][1]) return all[0][0];
    return '';
  }

  root.LangPack = {
    VERSION: '1.0.0',
    packs: PACKS,
    all: function () { return ENABLED.slice(); },
    get: function (code) { return PACKS[code] || null; },
    cityOf: function (written) { return CITY_MAP[foldKey(written)] || ''; },
    foldKey: foldKey,
    gloss: GLOSS,
    hintLatin: hintLatin
  };
})();
