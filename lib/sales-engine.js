// محرّك وكيل المبيعات (P2.1) — منطق نقي بلا قاعدة بيانات ولا شبكة.
// المبدأ: الوكيل يؤهّل الطلب ويسلّمه للفريق. لا سعر، لا خصم، لا وعد بالتوفّر، لا دفترة.

const STD_WIDTHS = [10, 15, 20];
const LEN_STEP = 5, LEN_MIN = 5, LEN_MAX = 120;
const SEATING_M2_PER_GUEST = { tables: 1.5, majlis: 1.2 };

function toLatinDigits(s) {
  return String(s || "").replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0));
}
function normalizeArabic(s) {
  return String(s || "").replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ـ/g, "");
}
const norm = (s) => normalizeArabic(toLatinDigits(s)).toLowerCase();

const REQUEST_LABELS = {
  european_tent: "خيمة أوروبية", bait_shaar: "بيت شعر", toilets: "دورات مياه متنقلة",
  full_event: "تجهيز فعالية متكامل", tent: "خيمة (النوع غير محدد)", other: "طلب آخر",
};
const MONTHS = { يناير: 1, فبراير: 2, مارس: 3, ابريل: 4, مايو: 5, يونيو: 6, يوليو: 7, اغسطس: 8,
  سبتمبر: 9, اكتوبر: 10, نوفمبر: 11, ديسمبر: 12 };
const MONTH_RE = Object.keys(MONTHS).join("|");
const CITIES = [
  ["الرياض", "الرياض"], ["جده", "جدة"], ["جدة", "جدة"], ["مكه", "مكة"], ["مكة", "مكة"],
  ["المدينه المنوره", "المدينة المنورة"], ["المدينة المنورة", "المدينة المنورة"], ["الدمام", "الدمام"],
  ["الخبر", "الخبر"], ["الظهران", "الظهران"], ["الطائف", "الطائف"], ["تبوك", "تبوك"], ["ابها", "أبها"],
  ["خميس مشيط", "خميس مشيط"], ["حائل", "حائل"], ["بريده", "بريدة"], ["بريدة", "بريدة"], ["عنيزه", "عنيزة"],
  ["عنيزة", "عنيزة"], ["القصيم", "القصيم"], ["الاحساء", "الأحساء"], ["الهفوف", "الهفوف"], ["الجبيل", "الجبيل"],
  ["ينبع", "ينبع"], ["نجران", "نجران"], ["جازان", "جازان"], ["جيزان", "جازان"], ["الباحه", "الباحة"],
  ["الباحة", "الباحة"], ["سكاكا", "سكاكا"], ["الجوف", "الجوف"], ["عرعر", "عرعر"], ["القطيف", "القطيف"],
  ["الخرج", "الخرج"], ["حفر الباطن", "حفر الباطن"], ["المجمعه", "المجمعة"], ["المجمعة", "المجمعة"],
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

// يستخرج ما قاله العميل فقط — ما لا يُذكر يبقى غير موجود (لا تخمين).
function extractSalesFields(text, now = new Date()) {
  const raw = String(text || "");
  const t = norm(raw);
  const out = {};

  if (/اوروبي/.test(t)) out.request_type = "european_tent";
  else if (/بيت\s*شعر|بيوت\s*شعر|خيام\s*شعر|خيمه\s*شعر/.test(t)) out.request_type = "bait_shaar";
  else if (/دور(ه|ات)\s*(ال)?مياه|حمامات\s*متنقل/.test(t)) out.request_type = "toilets";
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
  const gm = t.match(/(\d{1,5})\s*(?:شخص|اشخاص|ضيف|ضيوف|نفر|معزوم|مدعو)/);
  if (gm) out.guest_count = Number(gm[1]);
  const gr = t.match(/(?:العدد|عدد\s*(?:الضيوف|المعازيم|الناس))[^\d\n]{0,25}(\d{1,4})\s*(?:الي|-|او|و)\s*(\d{1,4})/);
  if (gr && !out.guest_count) { out.guest_count = Math.max(Number(gr[1]), Number(gr[2])); out.guest_range = `${gr[1]}–${gr[2]}`; }

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
    const hm = t.match(new RegExp(`(بدايه|بداية|اول|نص|منتصف|نهايه|نهاية|اخر)\\s*(?:شهر)?\\s*(\\d{1,2}|${MONTH_RE})`));
    if (hm) out.date_hint = raw.slice(raw.search(/بداي|أول|اول|نص|منتصف|نهاي|آخر|اخر/)).split(/\n|،|,/)[0].trim().slice(0, 40);
  }
  out.size_info_request = /(وش|ايش|كم)\s*(ال)?مقاس|المقاسات\s*(ال)?(متوفر|متاح)/.test(t);
  const EXTRAS = [["مفروش", "مفروش"], ["كهرب", "كهرباء"], ["مساند", "مساند"], ["مشب|شبه\\s*نار|للنار", "مشب/مكان نار"], ["تكييف|مكيف", "تكييف"], ["اناره|إضاءه", "إنارة"]];
  const extras = EXTRAS.filter(([re]) => new RegExp(re).test(t)).map(([, lab]) => lab);
  if (extras.length) out.extras = extras;
  if (/يومين/.test(t)) out.duration_days = 2;
  const du = t.match(/(\d{1,2})\s*(?:ايام|يوم)/);
  if (du && !dr) out.duration_days = Number(du[1]);
  if (/اسبوع/.test(t) && !out.duration_days) out.duration_days = 7;

  for (const [k, v] of CITIES) {
    if (t.includes(norm(k))) { out.city = v; break; }
  }
  const loc = raw.match(/حي\s+([^\s،,.]+(?:\s+[^\s،,.]+)?)/);
  if (loc) out.location_details = "حي " + loc[1];

  const ev = [["زواج|عرس|زفاف", "زواج"], ["ملكه|خطوبه", "ملكة"], ["عزاء", "عزاء"], ["تخرج", "تخرج"],
    ["مؤتمر", "مؤتمر"], ["مخيم", "مخيم"], ["معرض", "معرض"], ["مهرجان", "مهرجان"], ["عيد", "عيد"],
    ["عشاء|غداء|وليمه|عزيمه", "وليمة"], ["حفل|حفله", "حفل"]];
  for (const [re, lab] of ev) { if (new RegExp(re).test(t)) { out.event_type = lab; break; } }
  if (/بدون\s*(كراسي|كرسي|طاول)|ارضي|فرش\s*بر|مجالس|مجلس/.test(t)) out.seating_style = "majlis";
  else if (/طاول|كراسي|كرسي/.test(t)) out.seating_style = "tables";

  out.size_unsure = /(ما|مو)\s*(اعرف|ادري)|مدري|مو\s*متاكد|ما\s*عندي\s*فكره/.test(t) && /مقاس|قياس|حجم|مساح/.test(t);
  out.price_question = /سعر|اسعار|بكم|كم\s*(يكلف|التكلف|الحساب|تاخذ|المبلغ)|تكلف|خصم|تخفيض/.test(t);
  out.greeting = /السلام|مرحب|هلا/.test(t);
  out.yes = new RegExp(`^\\s*(نعم|ايوه|ايه|اي|صح|صحيح|تمام|اوكي|ok|مضبوط|اكيد)${END}`).test(t);
  out.no = new RegExp(`^\\s*(لا|غلط|مو\\s*صحيح|عدل)${END}`).test(t);
  out.wants_human = /(ابي|ابغي|اريد)\s*(اكلم|اتكلم|اتواصل)|موظف|شخص\s*من\s*الفريق|اتصل\s*علي|كلموني|اكلم\s*ولا|اتصل\s*ولا|اكلمكم|ابي\s*رقم/.test(t);
  return out;
}

// ─── المقاسات (كود حتمي لا نموذج لغوي) ───
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
const EURO_SIZED = ["european_tent", "tent", "full_event"];
function deriveSizing(L) {
  if (!EURO_SIZED.includes(L.request_type)) {
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

// ─── النواقص والحالة ───
const TENTISH = ["european_tent", "bait_shaar", "tent", "full_event"];
function computeSalesMissing(L) {
  const m = [];
  if (!L.request_type) m.push("request_type");
  else if (L.request_type === "tent") m.push("tent_kind");
  const hasSize = !!(L.requested_dimensions || L.approx_area || L.guest_count);
  if (!hasSize) m.push("size");
  else if (TENTISH.includes(L.request_type) && !L.requested_dimensions && !L.approx_area && !L.seating_style) m.push("event_details");
  if (!L.start_date) m.push("start_date");
  if (!L.end_date && !L.duration_days) m.push("end_date");
  if (!L.city) m.push("city");
  return m;
}
const SOFT_FIELDS = ["event_details"];
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
const QUESTIONS = {
  request_type: "وش نوع الطلب؟ خيام أوروبية، بيوت شعر، دورات مياه متنقلة، ولا تجهيز فعالية متكامل؟",
  tent_kind: "الخيمة اللي تبيها أوروبية ولا بيت شعر؟",
  size: "كم المساحة التقريبية أو عدد الضيوف المتوقع؟ وإذا تعرف المقاس المطلوب اذكره.",
  event_details: "المناسبة وش نوعها؟ والجلسات بتكون طاولات وكراسي ولا مجالس؟",
  start_date: "متى موعد المناسبة؟ من تاريخ كم إلى كم؟",
  end_date: "وإلى متى تحتاجها؟ (تاريخ النهاية أو عدد الأيام)",
  city: "في أي مدينة بيكون التنفيذ؟ وإذا عندك الحي أو الموقع اذكره.",
};
const SIZE_EXPLAIN = "الخيام الأوروبية عندنا عرضها 10 أو 15 أو 20 متر، والطول يكون على وحدات 5 متر مثل 20 أو 25 أو 30 متر.";

function customerSummary(L) {
  const lines = ["خلني أتأكد من طلبك:", `• الطلب: ${REQUEST_LABELS[L.request_type] || "—"}`];
  if (L.requested_dimensions) lines.push(`• المقاس: ${L.requested_dimensions.raw || dimsTxt(L.requested_dimensions)}`);
  else if (L.suggested_dimensions && L.suggested_dimensions.length) lines.push(`• مقاس مقترح مبدئياً: ${optsTxt(L.suggested_dimensions)}`);
  if (L.approx_area) lines.push(`• المساحة: ${L.approx_area} م²`);
  if (L.guest_count) lines.push(`• عدد الضيوف: ${L.guest_count}`);
  lines.push(`• الفترة: ${periodTxt(L)}`, `• المدينة: ${L.city}${L.location_details ? " — " + L.location_details : ""}`);
  lines.push("هل المعلومات صحيحة؟");
  return lines.join("\n");
}

// ctx: { greeting, priceAsked, nonstandardJustGiven, sizingJustDerived }
function composeSalesReply(L, ctx = {}) {
  const parts = [];
  if (ctx.greeting) parts.push("وعليكم السلام، حياك الله 🌿");
  if (ctx.priceAsked) parts.push("بخصوص السعر: الفريق يجهّز لك عرض السعر بعد ما تكتمل التفاصيل.");
  if (L.status === "ready_for_team") {
    parts.push("تمام، وصل طلبك للفريق وبيتواصلون معك بعرض السعر. شكراً لك 🌿");
    return parts.join("\n");
  }
  if (L.status === "ready_for_confirmation") { parts.push(customerSummary(L)); return parts.join("\n"); }
  if (ctx.nonstandardJustGiven && L.suggested_dimensions && L.suggested_dimensions.length) {
    parts.push(`${SIZE_EXPLAIN} أقرب مقاس قياسي لطلبك (${L.requested_dimensions.raw}): ${L.suggested_dimensions.map(dimsTxt).join(" أو ")} — أيهم يناسبك؟ وإذا حاب نكمل باقي التفاصيل ويختار الفريق الأنسب.`);
    return parts.join("\n");
  }
  if (ctx.sizingJustDerived && L.suggested_dimensions && L.suggested_dimensions.length) {
    parts.push(`مبدئياً يناسبك مقاس ${optsTxt(L.suggested_dimensions)} — والاعتماد النهائي للفريق.`);
  }
  const next = (L.missing_fields || [])[0];
  if (ctx.sizeInfoRequested) {
    if (L.request_type === "bait_shaar") parts.push("مقاسات بيوت الشعر يوضحها لك الفريق مع العرض حسب عدد الضيوف والمكان.");
    else if (["european_tent", "tent", "full_event"].includes(L.request_type) || !L.request_type) parts.push(SIZE_EXPLAIN);
  }
  if (next === "start_date" && L.date_hint) { parts.push(`ذكرت «${L.date_hint}» — تقريباً أي تاريخ بالضبط تبدأ؟`); return parts.join("\n"); }
  if (next === "end_date" && L.rental_mode === "monthly") { parts.push("كم شهر تحتاجها تقريباً؟"); return parts.join("\n"); }
  if (next === "size" && L.size_unsure) parts.push(`${SIZE_EXPLAIN} تقدر تعطيني المساحة التقريبية أو عدد الضيوف ونقترح لك المقاس المناسب؟`);
  else if (next === "event_details" && L.size_unsure) parts.push(`${SIZE_EXPLAIN} عشان نقترح لك مقاس مبدئي: ${QUESTIONS.event_details}`);
  else if (next) parts.push(QUESTIONS[next]);
  return parts.join("\n");
}

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

// ملخص الفريق — يُحفظ في اللوحة (P2.1) ولا يُرسل عبر واتساب بعد.
function buildTeamSummary(L, attachments = []) {
  const notes = [];
  if (L.event_type) notes.push(`المناسبة: ${L.event_type}`);
  if (L.seating_style) notes.push(`الجلسات: ${L.seating_style === "tables" ? "طاولات وكراسي" : "مجالس"}`);
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
  STD_WIDTHS, REQUEST_LABELS, extractSalesFields, isStandardDims, suggestFromArea, nearestStandardDims,
  suggestFromGuests, deriveSizing, computeSalesMissing, isQualified, composeSalesReply, guardSalesReply,
  buildTeamSummary, customerSummary,
};
