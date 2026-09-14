// محرّك وكيل المبيعات (P2.1/P2.2) — منطق نقي بلا قاعدة بيانات ولا شبكة.
// المبدأ: الوكيل يؤهّل الطلب ويسلّمه للفريق. لا سعر، لا خصم، لا وعد بالتوفّر، لا دفترة.

const STD_WIDTHS = [10, 15, 20];
const LEN_STEP = 5, LEN_MIN = 5, LEN_MAX = 120;
const SEATING_M2_PER_GUEST = { tables: 1.5, majlis: 1.2 };

function toLatinDigits(s) {
  return String(s || "").replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0));
}
function normalizeArabic(s) {
  return String(s || "").replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/ـ/g, "")
    .replace(/[ً-ْ]/g, "");
}
const norm = (s) => normalizeArabic(toLatinDigits(s)).toLowerCase();

const REQUEST_LABELS = {
  european_tent: "خيمة أوروبية", bait_shaar: "بيت شعر", toilets: "دورات مياه متنقلة",
  full_event: "تجهيز فعالية متكامل", tent: "خيمة (النوع غير محدد)", other: "طلب آخر",
};

// ─── قواعد المنتج حسب نوع الطلب ───
// order: ترتيب الأسئلة. soft: حقول مفيدة لا تمنع التأهيل وتُسأل مرة واحدة فقط.
// sizing: "euro" فقط للخيام الأوروبية — لا قواعد مقاسات مخترعة لبقية الأنواع.
const PRODUCT_RULES = {
  european_tent: { sizing: "euro", order: ["size", "event_details", "start_date", "end_date", "city"], soft: ["event_details"] },
  tent: { sizing: null, order: ["tent_kind", "size", "start_date", "end_date", "city"], soft: [] },
  bait_shaar: { sizing: null, order: ["size", "start_date", "end_date", "city", "use_type"], soft: ["use_type"] },
  toilets: { sizing: null, order: ["quantity", "start_date", "end_date", "city", "expected_users"], soft: ["expected_users"] },
  full_event: { sizing: null, order: ["guest_count", "event_type", "start_date", "end_date", "city", "services"], soft: ["services"] },
  _none: { sizing: null, order: ["request_type", "start_date", "end_date", "city"], soft: [] },
};
const rulesFor = (type) => PRODUCT_RULES[type] || PRODUCT_RULES._none;
const SOFT_FIELDS = [...new Set(Object.values(PRODUCT_RULES).flatMap((r) => r.soft))];

const MONTHS = { يناير: 1, فبراير: 2, مارس: 3, ابريل: 4, مايو: 5, يونيو: 6, يوليو: 7, اغسطس: 8,
  سبتمبر: 9, اكتوبر: 10, نوفمبر: 11, ديسمبر: 12 };
const MONTH_RE = Object.keys(MONTHS).join("|");
const CITIES = [
  ["الرياض", "الرياض"], ["جده", "جدة"], ["مكه", "مكة"], ["المدينه المنوره", "المدينة المنورة"], ["الدمام", "الدمام"],
  ["الخبر", "الخبر"], ["الظهران", "الظهران"], ["الطائف", "الطائف"], ["تبوك", "تبوك"], ["ابها", "أبها"],
  ["خميس مشيط", "خميس مشيط"], ["حائل", "حائل"], ["بريده", "بريدة"], ["عنيزه", "عنيزة"],
  ["القصيم", "القصيم"], ["الاحساء", "الأحساء"], ["الهفوف", "الهفوف"], ["الجبيل", "الجبيل"],
  ["ينبع", "ينبع"], ["نجران", "نجران"], ["جازان", "جازان"], ["جيزان", "جازان"], ["الباحه", "الباحة"],
  ["سكاكا", "سكاكا"], ["الجوف", "الجوف"], ["عرعر", "عرعر"], ["القطيف", "القطيف"],
  ["الخرج", "الخرج"], ["حفر الباطن", "حفر الباطن"], ["المجمعه", "المجمعة"],
  ["الدوادمي", "الدوادمي"], ["العلا", "العلا"], ["رفحاء", "رفحاء"],
];
const END = "(?=\\s|$|[،,.!؟?])";

function resolveDate(day, month, now) {
  if (!day || !month || day < 1 || day > 31 || month < 1 || month > 12) return null;
  let y = now.getUTCFullYear();
  const cm = now.getUTCMonth() + 1, cd = now.getUTCDate();
  if (month < cm || (month === cm && day < cd)) y += 1;
  return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
function monthOf(token, now) {
  if (!token) return null;
  if (/الشهر\s*(الجاي|القادم)/.test(token)) return ((now.getUTCMonth() + 1) % 12) + 1;
  if (/الشهر/.test(token)) return now.getUTCMonth() + 1;
  return MONTHS[token] || null;
}

// ─── نية التحويل لإنسان: يجب أن تكون صريحة ───
const HUMAN_TARGET = "(موظف|الموظف|احد|شخص|انسان|بشري|مسؤول|المسؤول|مندوب|المندوب|المدير|الاداره|خدمه\\s*العملاء)";
const HUMAN_RES = [
  new RegExp(`(ابي|ابغي|ابغا|اريد|ودي|ممكن|اقدر)\\s*(اكلم|اتكلم|اتحدث|احاكي|اتواصل)\\s*(مع\\s*)?${HUMAN_TARGET}`),
  new RegExp(`(ابي|ابغي|ابغا|اريد)\\s*(موظف|مسؤول|المسؤول|انسان|بشري|مندوب)`),
  /(حولني|حولوني|وصلني|وصلوني)/,
  new RegExp(`(ممكن|ابي|ابغي|ياليت|خل|خلي)\\s*${HUMAN_TARGET}\\s*(من\\s*الفريق\\s*)?(يتواصل|يكلمني|يتصل|يرد|يكلم)`),
  /(اتصلوا|اتصل|كلموني|كلمني)\s*(علي|عليا|فيني)/,
];
// أسئلة عن طريقة التواصل — غامضة، يُرد عليها طبيعياً (ليست طلب موظف)
// يسمح بكلمات بينية قصيرة: «أتواصل معكم اتصال ولا أرسل هنا؟»
const CONTACT_Q_RE = /(اكلم|اتصل|اتواصل|اكلمكم|اتصال|مكالمه)[^؟?\n]{0,20}?\s(ولا|او)\s*(ارسل|اكتب|هنا|رساله|واتس)|(ارسل|اكتب)[^؟?\n]{0,20}?\s(ولا|او)\s*(اكلم|اتصل)|ابي\s*(الرقم|رقم)|رقمكم|وش\s*رقم|كيف\s*اتواصل/;
const CONTACT_ISSUE_RE = /الرقم\s*(ناقص|غلط|خطا|ما\s*يشتغل|مقفل)/;

// يستخرج ما قاله العميل فقط — ما لا يُذكر يبقى غير موجود (لا تخمين).
function extractSalesFields(text, now = new Date()) {
  const raw = String(text || "");
  const t = norm(raw);
  const out = {};

  if (/اوروبي/.test(t)) out.request_type = "european_tent";
  else if (/بيت\s*شعر|بيوت\s*شعر|خيام\s*شعر|خيمه\s*شعر/.test(t)) out.request_type = "bait_shaar";
  else if (/دور(ه|ات)\s*(ال)?مياه|حمامات\s*متنقل|حمام\s*متنقل/.test(t)) out.request_type = "toilets";
  else if (/تجهيز\s*(فعالي|مناسب|حفل|كامل|متكامل)|تنظيم\s*فعالي/.test(t)) out.request_type = "full_event";
  else if (/(?<!م)خيم|خيام/.test(t)) out.request_type = "tent";

  const dm = t.match(/(\d{1,3}(?:\.\d)?)\s*(?:x|×|\*|في|ب)\s*(\d{1,3}(?:\.\d)?)/);
  if (dm) {
    const a = Number(dm[1]), b = Number(dm[2]);
    if (a >= 3 && b >= 3 && a <= 200 && b <= 200) {
      out.requested_dimensions = { width: Math.min(a, b), length: Math.max(a, b), raw: `${dm[1]}×${dm[2]}` };
    }
  }
  const am = t.match(/(\d{2,5})\s*(?:م2|م²|متر\s*مربع|مترمربع|m2|sqm)/);
  if (am) out.approx_area = Number(am[1]);
  const gm = t.match(/(\d{1,5})\s*(?:شخص|اشخاص|ضيف|ضيوف|نفر|معزوم|مدعو|حاضر)/);
  if (gm) out.guest_count = Number(gm[1]);
  const gr = t.match(/(?:العدد|عدد\s*(?:الضيوف|المعازيم|الناس|الحضور))[^\d\n]{0,25}(\d{1,4})\s*(?:الي|-|او|و)\s*(\d{1,4})/);
  if (gr && !out.guest_count) { out.guest_count = Math.max(Number(gr[1]), Number(gr[2])); out.guest_range = `${gr[1]}–${gr[2]}`; }
  // عدد وحدات دورات المياه
  const um = t.match(/(\d{1,3})\s*(?:دوره|دورات|حمام|حمامات|وحده|وحدات|كبينه|كبائن)/);
  if (um) out.units_count = Number(um[1]);
  const ttype = [["vip|فاخر|ملكي", "VIP"], ["ذوي\\s*(ال)?احتياج|معاقين", "لذوي الاحتياجات"], ["نسائي", "نسائية"], ["رجالي", "رجالية"]]
    .filter(([re]) => new RegExp(re).test(t)).map(([, l]) => l);
  if (ttype.length) out.unit_types = ttype;

  // التواريخ: الشهر مطلوب؛ بلا شهر لا نخمّن.
  let dr = t.match(new RegExp(`من\\s*(\\d{1,2})\\s*(?:الي|-|لين|حتي|ل)\\s*(\\d{1,2})\\s*(${MONTH_RE}|الشهر\\s*(?:الجاي|القادم)?)`));
  if (!dr) dr = t.match(new RegExp(`(\\d{1,2})\\s*(?:و|-|الي)\\s*(\\d{1,2})\\s*(${MONTH_RE}|الشهر\\s*(?:الجاي|القادم)?)`));
  if (dr) {
    const mo = monthOf(dr[3], now);
    const s = resolveDate(Number(dr[1]), mo, now), e = resolveDate(Number(dr[2]), mo, now);
    if (s && e) { out.start_date = s; out.end_date = e < s ? null : e; }
  } else {
    const ds = t.match(new RegExp(`(\\d{1,2})\\s*(${MONTH_RE})`));
    if (ds) { const s = resolveDate(Number(ds[1]), MONTHS[ds[2]], now); if (s) out.start_date = s; }
  }
  if (/بالشهر|شهري|شهر\s*كامل/.test(t)) out.rental_mode = "monthly";
  if (!out.start_date) {
    const hm = t.match(new RegExp(`(بدايه|اول|نص|منتصف|نهايه|اخر)\\s*(?:شهر)?\\s*(\\d{1,2}|${MONTH_RE})`));
    if (hm) out.date_hint = raw.slice(raw.search(/بداي|أول|اول|نص|منتصف|نهاي|آخر|اخر/)).split(/\n|،|,/)[0].trim().slice(0, 40);
  }
  out.size_info_request = /(وش|ايش|كم)\s*(ال)?مقاس|المقاسات\s*(ال)?(متوفر|متاح)|(وش|ايش)\s*(ال)?(احجام|حجم)/.test(t);
  const EXTRAS = [["مفروش", "مفروش"], ["كهرب", "كهرباء"], ["مساند", "مساند"], ["مشب|شبه\\s*نار|للنار", "مشب/مكان نار"], ["تكييف|مكيف", "تكييف"], ["اناره|اضاءه", "إنارة"]];
  const extras = EXTRAS.filter(([re]) => new RegExp(re).test(t)).map(([, lab]) => lab);
  if (extras.length) out.extras = extras;
  // الخدمات (تُعتمد فقط لطلبات التجهيز المتكامل)
  const SERVICES = [["خيم|خيام", "خيام"], ["كراسي|كرسي|طاول|جلسات|مجالس", "جلسات"], ["اضاءه|اناره", "إضاءة"],
    ["صوت|سماعات|دي\\s*جي", "صوتيات"], ["ضيافه|قهوه|بوفيه|كيترنج|طبخ", "ضيافة"], ["منصه|مسرح|كوشه", "منصة/كوشة"],
    ["تكييف|مكيف", "تكييف"], ["دورات\\s*مياه|حمامات", "دورات مياه"], ["فرش|سجاد|موكيت", "فرش"], ["شاشه|شاشات", "شاشات"]];
  const services = SERVICES.filter(([re]) => new RegExp(re).test(t)).map(([, lab]) => lab);
  if (services.length) out.services = services;

  if (/يومين/.test(t)) out.duration_days = 2;
  const du = t.match(/(\d{1,2})\s*(?:ايام|يوم)/);
  if (du && !dr) out.duration_days = Number(du[1]);
  if (/اسبوع/.test(t) && !out.duration_days) out.duration_days = 7;
  if (/شهرين/.test(t)) out.duration_days = 60;
  const mm = t.match(/(\d{1,2})\s*(?:شهور|اشهر)/);
  if (mm) out.duration_days = Number(mm[1]) * 30;

  for (const [k, v] of CITIES) {
    if (t.includes(norm(k))) { out.city = v; break; }
  }
  const loc = raw.match(/حي\s+([^\s،,.]+(?:\s+[^\s،,.]+)?)/);
  if (loc) out.location_details = "حي " + loc[1];

  const ev = [["زواج|عرس|زفاف", "زواج"], ["ملكه|خطوبه", "ملكة"], ["عزاء", "عزاء"], ["تخرج", "تخرج"],
    ["مؤتمر", "مؤتمر"], ["مخيم", "مخيم"], ["معرض", "معرض"], ["مهرجان", "مهرجان"], ["عيد", "عيد"],
    ["عشاء|غداء|وليمه|عزيمه", "وليمة"], ["حفل|حفله", "حفل"], ["فعاليه\\s*(شركه|حكومي)|شركه", "فعالية شركة"]];
  for (const [re, lab] of ev) { if (new RegExp(re).test(t)) { out.event_type = lab; break; } }
  if (/بدون\s*(كراسي|كرسي|طاول)|ارضي|فرش\s*بر|مجالس|مجلس/.test(t)) out.seating_style = "majlis";
  else if (/طاول|كراسي|كرسي/.test(t)) out.seating_style = "tables";

  out.size_unsure = /(ما|مو)\s*(اعرف|ادري)|مدري|مو\s*متاكد|ما\s*عندي\s*فكره/.test(t) && /مقاس|قياس|حجم|مساح|عدد/.test(t);
  out.price_question = /سعر|اسعار|بكم|كم\s*(يكلف|التكلف|الحساب|تاخذ|المبلغ)|تكلف|خصم|تخفيض/.test(t);
  out.greeting = /السلام|مرحب|هلا/.test(t);
  out.yes = new RegExp(`^\\s*(نعم|ايوه|ايه|اي|صح|صحيح|تمام|اوكي|ok|مضبوط|اكيد)${END}`).test(t);
  out.no = new RegExp(`^\\s*(لا|غلط|مو\\s*صحيح|عدل)${END}`).test(t);
  out.wants_human = HUMAN_RES.some((re) => re.test(t));
  out.contact_issue = CONTACT_ISSUE_RE.test(t);
  out.contact_question = !out.wants_human && (CONTACT_Q_RE.test(t) || out.contact_issue);
  return out;
}

// ─── المقاسات (كود حتمي لا نموذج لغوي) — للخيام الأوروبية فقط ───
function isStandardDims(d) {
  return d && STD_WIDTHS.includes(d.width) && d.length % LEN_STEP === 0 && d.length >= LEN_MIN && d.length <= LEN_MAX;
}
function suggestFromArea(area) {
  if (!area || area <= 0) return [];
  const opts = [];
  for (const w of STD_WIDTHS) {
    const l = Math.max(LEN_MIN, Math.ceil(area / w / LEN_STEP) * LEN_STEP);
    if (l > LEN_MAX) continue;
    if (l < w && opts.some((o) => o.width === l)) continue; // تكرار مقلوب
    opts.push({ width: w, length: l, area: w * l, waste: w * l - area });
  }
  return opts.sort((a, b) => a.waste - b.waste || Math.abs(a.length / a.width - 1.3) - Math.abs(b.length / b.width - 1.3))
    .slice(0, 3).map(({ width, length, area }) => ({ width, length, area }));
}
function nearestStandardDims(d) {
  const below = [...STD_WIDTHS].reverse().find((w) => w <= d.width);
  const above = STD_WIDTHS.find((w) => w >= d.width);
  const widths = [...new Set([below, above].filter(Boolean))];
  const l = Math.min(LEN_MAX, Math.max(LEN_MIN, Math.ceil(d.length / LEN_STEP) * LEN_STEP));
  return widths.map((w) => ({ width: w, length: l, area: w * l }));
}
function suggestFromGuests(guests, seating) {
  const f = SEATING_M2_PER_GUEST[seating];
  if (!guests || !f) return [];
  return suggestFromArea(Math.ceil(guests * f));
}
// يعيد المقاس المقترح وثقته بناءً على ما قاله العميل. requested لا يُلمس.
function deriveSizing(L) {
  if (rulesFor(L.request_type).sizing !== "euro") {
    return { suggested_dimensions: null, dimensions_confidence: L.requested_dimensions ? "given" : (L.size_unsure ? "unsure" : null) };
  }
  if (L.requested_dimensions) {
    return isStandardDims(L.requested_dimensions)
      ? { suggested_dimensions: null, dimensions_confidence: "given" }
      : { suggested_dimensions: nearestStandardDims(L.requested_dimensions), dimensions_confidence: "nonstandard" };
  }
  if (L.approx_area) return { suggested_dimensions: suggestFromArea(Number(L.approx_area)), dimensions_confidence: "derived_from_area" };
  if (L.guest_count && L.seating_style) {
    return { suggested_dimensions: suggestFromGuests(L.guest_count, L.seating_style), dimensions_confidence: "derived_from_guests" };
  }
  return { suggested_dimensions: null, dimensions_confidence: L.size_unsure ? "unsure" : null };
}

// ─── النواقص حسب نوع الطلب ───
const FIELD_SATISFIED = {
  request_type: (L) => !!L.request_type,
  tent_kind: (L) => L.request_type && L.request_type !== "tent",
  size: (L) => !!(L.requested_dimensions || L.approx_area || L.guest_count),
  event_details: (L) => !!(L.requested_dimensions || L.approx_area || L.seating_style),
  start_date: (L) => !!L.start_date,
  end_date: (L) => !!(L.end_date || L.duration_days),
  city: (L) => !!L.city,
  use_type: (L) => !!(L.seating_style || L.event_type),
  // دورات المياه: عدد الوحدات، أو عدد الحضور ليقدّر الفريق العدد
  quantity: (L) => !!(L.units_count || L.guest_count),
  expected_users: (L) => !!(L.guest_count || L.event_type),
  guest_count: (L) => !!L.guest_count,
  event_type: (L) => !!L.event_type,
  services: (L) => Array.isArray(L.requested_services) && L.requested_services.length > 0,
};
function computeSalesMissing(L) {
  return rulesFor(L.request_type).order.filter((f) => !FIELD_SATISFIED[f](L));
}
const isQualified = (missing) => missing.filter((f) => !SOFT_FIELDS.includes(f)).length === 0;

// ─── الصياغة ───
const dimsTxt = (d) => `${d.width}×${d.length}`;
const optsTxt = (arr) => (arr || []).map((d) => `${dimsTxt(d)} (${d.area} م²)`).join(" أو ");
function isoOf(v) {
  if (!v) return null;
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  return String(v).slice(0, 10);
}
function fmtDate(v) {
  const iso = isoOf(v);
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  const name = Object.keys(MONTHS).find((k) => MONTHS[k] === m);
  return `${d} ${name === "اكتوبر" ? "أكتوبر" : name === "ابريل" ? "أبريل" : name === "اغسطس" ? "أغسطس" : name} ${y}`;
}
function periodTxt(L) {
  if (!L.start_date && L.date_hint) return L.date_hint;
  if (L.start_date && L.end_date) return `من ${fmtDate(L.start_date)} إلى ${fmtDate(L.end_date)}`;
  if (L.start_date && L.duration_days) return `من ${fmtDate(L.start_date)} لمدة ${L.duration_days} أيام`;
  return fmtDate(L.start_date);
}

// سؤال أول مرة، وصياغة بديلة إذا سُئل قبل ولم يُجب — حتى لا يتكرر نفس السؤال حرفياً.
const QUESTIONS = {
  request_type: ["وش نوع الطلب؟ خيام أوروبية، بيوت شعر، دورات مياه متنقلة، ولا تجهيز فعالية متكامل؟",
    "عشان أوجّه طلبك صح: تحتاج خيام، بيوت شعر، دورات مياه، ولا تجهيز كامل للمناسبة؟"],
  tent_kind: ["الخيمة اللي تبيها أوروبية ولا بيت شعر؟", "بس عشان أوجّه طلبك صح: خيمة أوروبية ولا بيت شعر؟"],
  size: {
    european_tent: ["كم المساحة التقريبية أو عدد الضيوف المتوقع؟ وإذا تعرف المقاس المطلوب اذكره.",
      "عشان أكمل طلبك: تقريباً كم شخص بيحضر؟ أو إذا تعرف المساحة أو المقاس اذكره."],
    bait_shaar: ["كم عدد الضيوف تقريباً أو المساحة المتاحة في المكان؟",
      "عشان أكمل طلبك: تقريباً كم شخص بيجلس في بيت الشعر؟"],
    _: ["كم المساحة التقريبية أو عدد الضيوف المتوقع؟", "عشان أكمل طلبك: تقريباً كم شخص بيحضر؟"],
  },
  event_details: ["المناسبة وش نوعها؟ والجلسات بتكون طاولات وكراسي ولا مجالس؟", "الجلسات طاولات وكراسي ولا مجالس أرضية؟"],
  start_date: ["متى موعد المناسبة؟ من تاريخ كم إلى كم؟", "ومتى تقريباً تبدأ؟ (اليوم والشهر)"],
  end_date: ["وإلى متى تحتاجها؟ (تاريخ النهاية أو عدد الأيام)", "وكم يوم تحتاجها تقريباً؟"],
  city: ["في أي مدينة بيكون التنفيذ؟ وإذا عندك الحي أو الموقع اذكره.", "وين مكان التنفيذ؟ المدينة والحي يكفي."],
  use_type: ["الجلسة بتكون أرضية (مجالس) ولا طاولات وكراسي؟ ووش المناسبة؟", "الجلسة أرضية ولا طاولات؟"],
  quantity: ["كم وحدة دورات مياه تحتاج تقريباً؟ وإذا عندك نوع معيّن (عادية، VIP، لذوي الاحتياجات) اذكره.",
    "كم وحدة تقريباً؟ وإذا مو متأكد قل لي عدد الحضور ويقدّر الفريق العدد المناسب."],
  expected_users: ["كم عدد الحضور المتوقع تقريباً؟ يساعد الفريق يحدد العدد المناسب.", "تقريباً كم شخص بيستخدمها؟"],
  guest_count: ["كم عدد الضيوف المتوقع تقريباً؟", "عشان أكمل طلبك: تقريباً كم شخص بيحضر؟"],
  event_type: ["وش نوع المناسبة؟ (زواج، حفل، مؤتمر، معرض، فعالية شركة...)", "المناسبة زواج ولا حفل ولا غيرها؟"],
  services: ["وش الخدمات الأساسية اللي تحتاجها؟ مثل الخيام، الجلسات، الإضاءة، الصوتيات، الضيافة.",
    "وش أهم الخدمات اللي تبيها في التجهيز؟"],
};
function questionFor(L, field, variant) {
  let q = QUESTIONS[field];
  if (q && !Array.isArray(q)) q = q[L.request_type] || q._;
  return q ? q[Math.min(variant, q.length - 1)] : null;
}

const PRICE_LINE = ["بخصوص السعر: الفريق يجهّز لك عرض السعر بعد ما تكتمل التفاصيل.",
  "أكيد، مثل ما ذكرت لك: عرض السعر يوصلك من الفريق أول ما تكتمل التفاصيل."];
const SIZE_EXPLAIN = "الخيام الأوروبية عندنا عرضها 10 أو 15 أو 20 متر، والطول يكون على وحدات 5 متر مثل 20 أو 25 أو 30 متر.";
// شرح «وش المقاسات» حسب النوع: [أول مرة، إذا تكرر السؤال]
const SIZE_INFO = {
  european_tent: [SIZE_EXPLAIN,
    "أكيد، مثل ما ذكرت لك: العرض 10 أو 15 أو 20 متر والطول بمضاعفات 5 متر. أعطني عدد الضيوف وأقترح لك الأنسب."],
  bait_shaar: ["مقاسات بيوت الشعر يوضحها لك الفريق مع العرض حسب عدد الضيوف والمكان.",
    "أكيد، مثل ما ذكرت لك: مقاس بيت الشعر يحدده الفريق حسب عدد ضيوفك والمكان، ويوضح لك الخيارات مع العرض."],
  toilets: ["دورات المياه المتنقلة تتحدد بعدد الوحدات ونوعها، مو بالمساحة.",
    "أكيد، مثل ما ذكرت لك: الأهم عدد الوحدات ونوعها، والفريق يساعدك تحدد العدد من عدد الحضور."],
  full_event: ["التجهيز المتكامل يتحدد حسب عدد الضيوف ونوع المناسبة والموقع، والفريق يقترح لك التوزيع المناسب.",
    "أكيد، مثل ما ذكرت لك: الفريق يحدد التجهيز حسب عدد ضيوفك ونوع المناسبة."],
  _: ["المقاسات تختلف حسب النوع: الخيام الأوروبية لها مقاسات قياسية، وبيوت الشعر يحددها الفريق حسب المكان والضيوف.",
    "أكيد، مثل ما ذكرت لك: المقاس يعتمد على نوع الخيمة. حدد لي النوع وأوضح لك."],
};
const CONTACT_LINE = ["تقدر تكمل معي هنا بالواتساب وأنا أجهّز طلبك للفريق. وإذا تفضّل أحد من الفريق يتواصل معك، قل لي «أبي أحد يتواصل معي».",
  "أكيد، الأسهل تكمل هنا وأنا أرتب طلبك، ولو تبي اتصال من الفريق اكتب «أبي أحد يتصل علي»."];
const CONTACT_ISSUE_LINE = ["عذراً على ذلك! تقدر تكمل معي هنا، وإذا تبي أحد من الفريق يتصل عليك قل لي «أبي أحد يتصل علي».",
  "عذراً مرة ثانية، سجّلت الملاحظة للفريق. نكمل هنا؟"];
const FIELD_ACK = { city: "المدينة", location_details: "الموقع", guest_count: "عدد الضيوف", start_date: "التاريخ",
  units_count: "عدد الوحدات", event_type: "نوع المناسبة", seating_style: "نوع الجلسة", approx_area: "المساحة" };

// سجل المحادثة: ما قيل (topics) وما سُئل (asked) — مبني على الموضوع لا على النص الحرفي.
function emptyHistory() { return { topics: {}, asked: {}, lastAsked: null, lastText: null }; }
function buildHistory(outs = []) {
  const H = emptyHistory();
  for (const o of outs) {
    const x = o && o.extracted ? o.extracted : {};
    for (const tp of x.topics || []) H.topics[tp] = (H.topics[tp] || 0) + 1;
    if (x.asked) { H.asked[x.asked] = (H.asked[x.asked] || 0) + 1; H.lastAsked = x.asked; }
    if (o && o.text) H.lastText = o.text;
  }
  return H;
}
// تشابه الكلمات (Jaccard) — شبكة أمان إضافية فوق منطق المواضيع، لا بديل عنه.
function tokenSet(s) { return new Set(norm(s).replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 1)); }
function similarity(a, b) {
  if (!a || !b) return 0;
  const A = tokenSet(a), B = tokenSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

function customerSummary(L) {
  const lines = ["خلني أتأكد من طلبك:", `• الطلب: ${REQUEST_LABELS[L.request_type] || "—"}`];
  if (L.requested_dimensions) lines.push(`• المقاس: ${L.requested_dimensions.raw || dimsTxt(L.requested_dimensions)}`);
  else if (L.suggested_dimensions && L.suggested_dimensions.length) lines.push(`• مقاس مقترح مبدئياً: ${optsTxt(L.suggested_dimensions)}`);
  if (L.units_count) lines.push(`• عدد الوحدات: ${L.units_count}`);
  if (L.approx_area) lines.push(`• المساحة: ${L.approx_area} م²`);
  if (L.guest_count) lines.push(`• عدد الضيوف: ${L.guest_count}`);
  if (L.request_type === "full_event" && L.event_type) lines.push(`• المناسبة: ${L.event_type}`);
  if (L.request_type === "full_event" && (L.requested_services || []).length) lines.push(`• الخدمات: ${L.requested_services.join("، ")}`);
  lines.push(`• الفترة: ${periodTxt(L)}`, `• المدينة: ${L.city}${L.location_details ? " — " + L.location_details : ""}`);
  lines.push("هل المعلومات صحيحة؟");
  return lines.join("\n");
}

// اختيار السؤال التالي: الإلزامي أولاً بترتيب النوع؛ الحقل الناعم يُسأل مرة واحدة فقط؛
// سؤال سُئل مرتين دون إجابة يُؤجَّل لصالح سؤال آخر حتى لا يلحّ الوكيل.
// إذا سُئلت كل النواقص مرتين دون إجابة ⇒ exhausted: لا نعيد السؤال (رسالة «خذ راحتك» مرة واحدة ثم صمت).
function pickNext(L, H) {
  const missing = L.missing_fields || [];
  const cands = missing.filter((f) => !(SOFT_FIELDS.includes(f) && (H.asked[f] || 0) >= 1));
  const fresh = cands.find((f) => (H.asked[f] || 0) < 2);
  if (fresh) return { field: fresh, exhausted: false };
  return cands[0] ? { field: cands[0], exhausted: true } : { field: null, exhausted: false };
}
const WAIT_LABEL = { start_date: "التاريخ", end_date: "المدة", size: "عدد الضيوف", guest_count: "عدد الضيوف",
  quantity: "عدد الوحدات", city: "المكان", event_type: "نوع المناسبة", request_type: "نوع الطلب", tent_kind: "نوع الخيمة" };

// ctx: { greeting, priceAsked, sizeInfoRequested, nonstandardJustGiven, sizingJustDerived,
//        contactQuestion, contactIssue, ack[], changed, history, forceAlt }
function composeSalesReplyEx(L, ctx = {}) {
  const H = ctx.history || emptyHistory();
  const said = (tp) => ctx.forceAlt || (H.topics[tp] || 0) > 0;
  const parts = [], topics = [];
  let asked = null;
  const add = (tp, text) => { if (text) { parts.push(text); topics.push(tp); } };
  const done = () => {
    const text = parts.join("\n");
    // شبكة أمان: رد شبه مطابق للرد السابق ⇒ نعيد الصياغة بالصيغ البديلة
    if (!ctx.forceAlt && H.lastText && similarity(text, H.lastText) >= 0.8) {
      const bumped = { ...H, asked: { ...H.asked } };
      if (asked) bumped.asked[asked] = Math.max(1, bumped.asked[asked] || 0);
      return composeSalesReplyEx(L, { ...ctx, forceAlt: true, history: bumped });
    }
    return { text, topics, asked };
  };

  if (ctx.greeting && !(H.topics.greeting > 0)) add("greeting", "وعليكم السلام، حياك الله 🌿");
  if (ctx.priceAsked) add("price_policy", PRICE_LINE[said("price_policy") ? 1 : 0]);
  if (L.status === "ready_for_team") { add("done", "تمام، وصل طلبك للفريق وبيتواصلون معك بعرض السعر. شكراً لك 🌿"); return done(); }
  if (L.status === "ready_for_confirmation") {
    if (said("summary") && !ctx.changed) add("summary_nudge", "هل التفاصيل اللي أرسلتها لك صحيحة؟ وإذا فيه تعديل قل لي.");
    else add("summary", customerSummary(L));
    return done();
  }
  if (ctx.contactIssue) add("contact_issue", CONTACT_ISSUE_LINE[said("contact_issue") ? 1 : 0]);
  else if (ctx.contactQuestion) add("contact", CONTACT_LINE[said("contact") ? 1 : 0]);
  // التأكيد على الاستلام فقط أثناء المحادثة (لا في أول رد)
  if (!parts.length && H.lastText && ctx.ack && ctx.ack.length) add("ack", `تمام، سجّلت ${ctx.ack.join(" و")}.`);

  const euro = rulesFor(L.request_type).sizing === "euro";
  if (euro && ctx.nonstandardJustGiven && L.suggested_dimensions && L.suggested_dimensions.length) {
    const expl = said("size_explain:european_tent") ? "" : SIZE_EXPLAIN + " ";
    topics.push("size_explain:european_tent");
    add(`suggestion:${L.suggested_dimensions.map(dimsTxt).join(",")}`,
      `${expl}أقرب مقاس قياسي لطلبك (${L.requested_dimensions.raw}): ${L.suggested_dimensions.map(dimsTxt).join(" أو ")} — أيهم يناسبك؟ وإذا حاب نكمل باقي التفاصيل ويختار الفريق الأنسب.`);
    return done();
  }
  if (euro && ctx.sizingJustDerived && L.suggested_dimensions && L.suggested_dimensions.length) {
    add(`suggestion:${L.suggested_dimensions.map(dimsTxt).join(",")}`, `مبدئياً يناسبك مقاس ${optsTxt(L.suggested_dimensions)} — والاعتماد النهائي للفريق.`);
  }
  if (ctx.sizeInfoRequested) {
    const key = SIZE_INFO[L.request_type] ? L.request_type : "_";
    add(`size_explain:${key}`, SIZE_INFO[key][said(`size_explain:${key}`) ? 1 : 0]);
  }

  const pick = pickNext(L, H);
  if (pick.exhausted) {
    // لا إلحاح: تذكير لطيف مرة واحدة، وبعده لا رد مقترح ما لم يضف العميل جديداً
    if (!said("wait")) add("wait", `خذ راحتك 🌿 أول ما تحدد ${WAIT_LABEL[pick.field] || "التفاصيل"} أرسله لي وأكمل طلبك للفريق.`);
    return { text: parts.join("\n"), topics, asked: null };
  }
  const next = pick.field;
  if (next) {
    asked = next;
    const variant = ctx.forceAlt ? 1 : Math.min(1, H.asked[next] || 0);
    if (next === "start_date" && L.date_hint) {
      add("ask", variant ? `عشان يحجز الفريق التاريخ الصحيح: أي يوم بالضبط تقريباً؟` : `ذكرت «${L.date_hint}» — تقريباً أي تاريخ بالضبط تبدأ؟`);
    } else if (next === "end_date" && L.rental_mode === "monthly") {
      add("ask", variant ? "والمدة كم شهر تقريباً؟" : "كم شهر تحتاجها تقريباً؟");
    } else if (euro && ["size", "event_details"].includes(next) && L.size_unsure && !said("size_explain:european_tent")) {
      topics.push("size_explain:european_tent");
      add("ask", next === "size"
        ? `${SIZE_EXPLAIN} تقدر تعطيني المساحة التقريبية أو عدد الضيوف ونقترح لك المقاس المناسب؟`
        : `${SIZE_EXPLAIN} عشان نقترح لك مقاس مبدئي: ${questionFor(L, "event_details", 0)}`);
    } else {
      add("ask", questionFor(L, next, variant));
    }
  }
  return done();
}
const composeSalesReply = (L, ctx = {}) => composeSalesReplyEx(L, ctx).text;

// حاجز صلب: أي رد فيه سعر أو خصم أو وعد يُحجب قبل أن يراه أحد.
function guardSalesReply(text) {
  const t = norm(text);
  const rules = [
    [/\d[\d,.]*\s*(ريال|ر\.?\s?س|sar)/i, "مبلغ بعملة"], [/(ريال|ر\.?\s?س|sar)\s*\d/i, "مبلغ بعملة"],
    [/خصم|تخفيض|عرض\s*خاص/, "خصم"], [/مضمون|نضمن|متوفر|متاح\s*اكيد|نحجز\s*لك|محجوز|اكيد\s*موجود/, "وعد بالتوفّر"],
    [/السعر\s*(هو|يكون|:)?\s*\d/, "رقم سعر"],
  ];
  for (const [re, why] of rules) if (re.test(t)) return { ok: false, reason: why };
  return { ok: true };
}

// ملخص الفريق — يُحفظ في اللوحة ولا يُرسل عبر واتساب بعد.
function buildTeamSummary(L, attachments = []) {
  const notes = [];
  if (L.event_type) notes.push(`المناسبة: ${L.event_type}`);
  if (L.seating_style) notes.push(`الجلسات: ${L.seating_style === "tables" ? "طاولات وكراسي" : "مجالس"}`);
  if (L.request_type === "toilets") notes.push(L.units_count ? `عدد الوحدات: ${L.units_count}` : "عدد الوحدات يقدّره الفريق من عدد الحضور");
  if ((L.requested_services || []).length) notes.push(`الخدمات المطلوبة: ${L.requested_services.join("، ")}`);
  if (L.size_unsure) notes.push("العميل غير متأكد من المقاس");
  if (L.dimensions_confidence === "nonstandard") notes.push("المقاس المطلوب غير قياسي");
  if (L.rental_mode === "monthly") notes.push("إيجار بالشهر");
  if (L.date_hint && !L.start_date) notes.push(`الموعد التقريبي: ${L.date_hint}`);
  if (L.customer_notes) notes.push(L.customer_notes);
  const sugNote = L.dimensions_confidence === "derived_from_guests" ? " (اقتراح مبدئي من عدد الضيوف)"
    : L.dimensions_confidence === "derived_from_area" ? " (اقتراح من المساحة)"
    : L.dimensions_confidence === "nonstandard" ? " (أقرب قياسي)" : "";
  const att = attachments.length ? attachments.map((a) => a.name || a.content_type || "مرفق").join("، ") : "لا يوجد";
  return [
    "طلب عميل جديد", "",
    `العميل: ${L.customer_name || "—"}`,
    `الجوال: ${L.customer_phone}`,
    `نوع الطلب: ${REQUEST_LABELS[L.request_type] || "—"}`,
    `المقاس المطلوب: ${L.requested_dimensions ? (L.requested_dimensions.raw || dimsTxt(L.requested_dimensions)) : "—"}`,
    `المقاس المقترح: ${L.suggested_dimensions && L.suggested_dimensions.length ? optsTxt(L.suggested_dimensions) + sugNote : "—"}`,
    `المساحة: ${L.approx_area ? L.approx_area + " م²" : "—"}`,
    `عدد الضيوف: ${L.guest_count || "—"}`,
    `الفترة: ${periodTxt(L)}`,
    `المدينة: ${L.city || "—"}`,
    `الموقع: ${L.location_details || (L.location_lat ? `${L.location_lat}, ${L.location_lng}` : "—")}`,
    `الملاحظات: ${notes.length ? notes.join(" · ") : "—"}`,
    `المرفقات: ${att}`, "",
    "الحالة: جاهز للتسعير عبر دفترة",
  ].join("\n");
}

module.exports = {
  isoOf,
  STD_WIDTHS, REQUEST_LABELS, PRODUCT_RULES, SOFT_FIELDS, extractSalesFields, isStandardDims, suggestFromArea,
  nearestStandardDims, suggestFromGuests, deriveSizing, computeSalesMissing, isQualified, composeSalesReply,
  composeSalesReplyEx, buildHistory, similarity, guardSalesReply, buildTeamSummary, customerSummary, FIELD_ACK,
};
