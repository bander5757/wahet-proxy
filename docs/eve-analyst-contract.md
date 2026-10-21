# عقد تكامل «المحلل المراقب» مع صندوق الواتساب

محلل خارجي (eve أو غيره) يقرأ سجلات صندوق الواتساب ويحفظ **اقتراحاً** فقط.
القرار يبقى للمراجع البشري في اللوحة. هذا العقد لا يفترض أن المحلل يصل إلى Peach
ولا إلى جلسة Claude: كل ما يحتاجه هو HTTPS إلى خادم واحة ورمز بنطاق واحد.

## الحدود (يفرضها الكود لا التعليمات)

| ممنوع | كيف يُمنع |
|---|---|
| الاعتماد/الرفض/التعديل | هذه المسارات تتطلب **جلسة مستخدم** بدور owner/accountant؛ رمز المحلل لا يُنشئ جلسة |
| الترحيل المالي | لا مسار للمحلل يكتب في `finance_entries` |
| تعديل التحليل الأصلي | لا يكتب في `whatsapp_intake` إطلاقاً: `parsed_data` و`final_data` و`status` و`classification` خارج متناوله |
| إدخال رسائل جديدة | `/intake/whatsapp` يقبل نطاق `intake_sync` فقط، ورمز المحلل نطاقه `intake_analyze` |
| إرسال واتساب | لا علاقة لهذا المسار بـPeach أصلاً |
| رؤية ما لا يلزم | الطابور بلا رقم جوال ولا رابط مرفق ولا حمولة خام؛ ونصّ المستند عند الطلب فقط |

## المصادقة

ترويسة `x-analyst-token` برمز مُخزَّن **كبصمة sha256** في `app_settings.sync_tokens`
بالشكل: `{ hash, scope: "intake_analyze", label, active }`.
الإبطال: `active=false` أو حذف العنصر. لا يصلح هذا الرمز لأي نطاق آخر.

القراءة متاحة أيضاً لمراجع بشري بجلسة (owner/accountant) لعرض النتائج في اللوحة.

## المسارات

### 1) ما يحتاج تحليلاً
```
GET /api/app/intake/analysis/queue?analyzer=eve&version=1.0.0&limit=20[&include_skipped=true]
x-analyst-token: ***
```
السجلات القابلة للمراجعة التي لم يُكمِل هذا المحلل تحليلها بهذا الإصدار.
**بلا رقم جوال، وبلا رابط مرفق، وبلا حمولة خام.**

```jsonc
{ "ok": true, "data": [
  { "id": "6f0e…", "provider_message_id": "26025002",
    "sender_name": "عمر المشرف",
    "original_message": "تفريغ العهدة يوم 20",
    "message_timestamp": "2026-10-20T19:33:28.087Z",
    "status": "needs_review",
    "attachment_name": "تفريغ العهده يوم20.pdf",
    "attachment_mime": "application/pdf",
    "has_attachment": true,
    "extracted_text_len": 0,
    "extraction_status": "no_text",
    "extraction_ran": true,
    "text_available": false }
] }
```

**تحذير:** `extracted_text_len = 0` **ليس دليلاً** على أن المستند ممسوح. اقرأ `extraction_status`:

| الحالة | المعنى |
|---|---|
| `extracted` | نصّ متاح |
| `no_text` | نُزِّل الملف ولم يُعثَر على نص — غالباً ممسوح، وليس يقيناً |
| `not_extractable` | نوع لا يدعمه المستخرج (صورة مثلاً) |
| `fetch_failed` | **لم يُنزَّل الملف** — لا تستنتج شيئاً عن محتواه |
| `skipped` | المضيف غير مسموح — لم يُقرأ أصلاً |
| `error` / `absent` | خطأ أثناء المعالجة، أو لم تُجرَّ معالجة بعد |

في `fetch_failed` و`skipped` و`error` و`absent` **لا تَحكُم على المستند**: اطلب نصّه من واجهة
المصدر أدناه، وإن تعذّر فأعد `status: "failed"` بسبب واضح لتُعاد المحاولة.

### 1-ب) نصّ المستند
```
GET /api/app/intake/analysis/source/<intake_id>
x-analyst-token: ***
```
النص الخام **لا يُخزَّن** في القاعدة (يُمسح بعد التحليل حفاظاً على الخصوصية)، فيُستخرج عند الطلب
ويُعاد دون حفظ. الرابط الموقّع للمرفق **لا يُكشف**.

```jsonc
{ "ok": true, "data": {
  "intake_id": "6f0e…", "caption": "ديزل",
  "attachment_name": "TransferReceipt.pdf", "attachment_mime": "application/pdf",
  "has_attachment": true,
  "extraction_status": "extracted", "reason": null,
  "bytes": 77758, "content_type": "application/pdf",
  "text_len": 336, "text": "Transfer ReceiptDate 2026/09/18 …" } }   // حتى 20,000 حرف
```

### 2) حفظ نتيجة التحليل
```
POST /api/app/intake/analysis
x-analyst-token: ***
```
```jsonc
{
  "intake_id": "uuid",                 // إلزامي
  "analyzer": "eve",                   // إلزامي
  "analyzer_version": "1.0.0",         // إلزامي — جزء من مفتاح منع التكرار
  "status": "completed|failed|skipped",
  "fields": {                          // كلها اختيارية، وما لا يُعرف يُهمل
    "amount": 1250.5,                  // > 0 فقط (الصفر والفارغ مرفوضان)
    "transaction_date": "2026-10-20",  // YYYY-MM-DD
    "reference": "9120092600123456",   // 6–24 رقماً
    "from_iban_last4": "4266", "to_iban_last4": "9804",
    "counterparty": "", "bank": "", "site": "", "payer": "", "payee": "",
    "custody_holder": "عمر", "description": ""
  },
  "suggested_classification": "custody",   // من القائمة المغلقة فقط وإلا null
  //   expense | receipt | internal_transfer | custody | refund | operational_update | unknown
  "missing_fields": ["site"],              // حتى 20
  "questions": ["لمن العهدة؟", { "key": "site", "text": "أي موقع؟" }],
  "alerts": ["مجموع البنود لا يطابق إجمالي المستند"],
  "items": [                                // تفريغ العهدة: حتى 500 بند
    { "date": "2026-10-20", "description": "ديزل", "amount": 580,
      "direction": "out", "kind": "expense", "site": "ساجر", "payee": "يوسف", "row_no": 118 },
    { "date": "2026-10-20", "description": "عهدة من ح/ أبو فايز", "amount": 1000,
      "direction": "in", "kind": "funding" }
  ],
  "reported_total": 7697.00,               // إجمالي المصروفات كما يظهر في المستند
  "opening_balance": 98.64,                // الرصيد الافتتاحي من الكشف (يقبل الصفر والسالب)
  "closing_balance": 696.44,               // الرصيد الختامي المعلن في الكشف
  "attachment_kind": "pdf_scan",           // none|pdf_text|pdf_scan|image|excel|other
  "needs_vision": true, "needs_excel": false,
  "error": "سبب الفشل عند status=failed"
}
```
### الحساب في الخادم — لا يعلنه المحلل

كل العمليات **بالهللات (أعداد صحيحة)**، فلا يتسرّب خطأ العوائم. **ولا يوجد أي تسامح**:
التطابق تام أو يُعرض الفرق الفعلي.

`items_in_total` مجموع الداخل · `items_spent_total` مجموع الخارج عدا المُعاد ·
`items_returned_total` مجموع البنود `kind="return"`.

**(أ) مطابقة المصروفات**
`expenses_diff = items_spent_total − reported_total` و`expenses_match = (expenses_diff === 0)`.
بلا `reported_total` أو بلا بنود ⇒ `expenses_match = null` (غير محسوبة، وليست نجاحاً).

**(ب) تسوية العهدة**
`expected_closing = opening_balance + items_in_total − items_spent_total − items_returned_total`
و`settlement_diff = closing_balance − expected_closing`.

| الحالة | المعنى |
|---|---|
| `balanced` | الفرق صفر بالضبط |
| `mismatch` | يوجد فرق، وقيمته في `settlement_diff` |
| `not_computed` | ينقص رصيد افتتاحي أو ختامي أو لا بنود — **لا تُعدّ نجاحاً** |

أنواع البنود: `expense` · `funding` · `advance` · `collection` · `return` · `other`.

**الردود:** `201` عند الحفظ، `409` إذا وُجد تحليل **مكتمل أو متخطّى** لنفس (السجل + المحلل + الإصدار)،
`404` لسجل غير موجود، `400` لحقول إلزامية ناقصة، `401` بلا رمز صالح، `503` إن لم تُطبَّق الهجرة.

```jsonc
{ "ok": true, "data": {
  "id": "a1b2…", "intake_id": "6f0e…", "status": "completed", "attempts": 1,
  "items_count": 2, "expenses_match": false, "expenses_diff": -0.50,
  "settlement_status": "mismatch", "settlement_diff": -70.00, "retried": false } }
```

### سلوك `skipped` (ما يحتاج قارئ مرفقات)
استخدمه حين لا تستطيع قراءة المستند (ممسوح أو Excel) مع `needs_vision` أو `needs_excel` و`attachment_kind`:
- **يخرج السجل من الطابور** الافتراضي لهذا الإصدار، فلا يدور المحلل على ما لا يقدر عليه.
- **لاستعادته:** `?include_skipped=true` للمراجعة اليدوية، أو — وهو الموصى به بعد توفير قارئ
  المرفقات — **ارفع `analyzer_version`** فيُعاد تحليله ويبقى سجل الإصدار القديم للمقارنة.
- الكتابة فوق `skipped` بنفس الإصدار تُرفض بـ`409`؛ أما `failed` فيُعاد عليه في نفس الإصدار.

**إعادة المحاولة:** إن كان التحليل السابق `failed`، يُحدَّث الصف نفسه ويزيد `attempts` — فلا يتكرر صف.
**التزامن:** محللان على نفس الرسالة في اللحظة نفسها ⇒ الفهرس الفريد يحسم، فينجح أحدهما ويتلقّى الآخر `409` (لا 500 ولا صف مكرر).
**إصدار جديد** (`analyzer_version` مختلف) يُنشئ صفاً مستقلاً، فتقارن دقة الإصدارات قبل اعتماد أحدها.

### 3) قراءة النتائج
```
GET /api/app/intake/analysis/<intake_id>
```
مصفوفة بكل التحليلات (الأحدث أولاً) بحقولها كاملة: `fields`, `items`, `items_in_total`,
`items_spent_total`, `items_returned_total`, `reported_total`, `expenses_diff`, `expenses_match`,
`opening_balance`, `closing_balance`, `expected_closing`, `settlement_diff`, `settlement_status`,
`missing_fields`, `questions`, `alerts`, `attachment_kind`, `needs_vision`, `needs_excel`,
`status`, `error`, `attempts`, `analyzed_at`.

## التخزين
جدول `intake_analysis` (هجرة `migrations/2026-10-21_intake_analysis.sql` — **مطبّقة على staging في 2026-10-21**، والإنتاج لم يُمسّ).
فهرس فريد على `(intake_id, analyzer, analyzer_version)` هو ضمانة منع التكرار.
بنود تفريغ العهدة تُحفظ كمصفوفة داخل الصف، فلا يوجد جدول حركات يضاعف الإجماليات.

## العرض في اللوحة
صندوق الواتساب يعرض أحدث تحليل تحت عنوان «🔎 اقتراح المحلل — للاطلاع فقط، القرار لك»:
التصنيف المقترح، والبنود (مصروف/مستلم/مُعاد)، وسطر مطابقة المصروفات بفرقه، وسطر تسوية العهدة
(متزنة / فرق كذا / غير محسوبة)، والنواقص، والأسئلة، والتنبيهات. أزرار الاعتماد والرفض تبقى منفصلة ولا يمسّها المحلل.

## متغيرات البيئة (أسماء فقط)
- على خادم واحة: لا جديد. المصادقة عبر رمز مخزَّن في قاعدة البيانات.
- على طرف المحلل: `WAHET_BASE` و`WAHET_ANALYST_TOKEN`.

## تنبيه صلاحيات (خارج نطاق هذه المهمة)
الاعتماد اليوم لدورَي **owner** و**accountant** فقط (`requireIntakeApprover`).
المطلوب عملياً أن يعتمد **بندر وعمر**: بندر owner فيعتمد، أما **عمر فدوره supervisor فلا يستطيع**.
لم يُغيَّر شيء في هذه المهمة. الخيارات لاحقاً: منح عمر صلاحية دقيقة مثل `intake.review`
على غرار `sales.review`، أو تغيير دوره إلى accountant (يمنحه صلاحيات مالية أوسع).
