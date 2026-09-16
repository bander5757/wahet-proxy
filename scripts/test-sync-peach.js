// اختبارات منطق مزامنة الفريق (نقي، بلا شبكة وبلا قاعدة بيانات).
const { classifyMessage, intakePayload, isRetryable, digits } = require("./sync-peach-team");

let passed = 0, failed = 0;
const ok = (n, c, e) => { if (c) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.log(`  ❌ ${n}${e ? " — " + e : ""}`); } };
const ctx = () => ({
  teamBy: new Map([["966541449943", "بندر"], ["966504165148", "أبو فايز"], ["966506834579", "عمر"]]),
  recent: new Set(["111"]), lastCreatedAt: "2026-09-15T00:00:00.000Z",
});
const msg = (o) => Object.assign({
  id: 900, direction: "inbound", business_phone_number: "+966 55 203 9917",
  contact: { id: 1, name: "بندر العوفي", phone_number: "+966541449943" },
  text: "ديزل", content_type: "document", created_at: "2026-09-15T21:26:37.468Z",
}, o);

console.log("— الفلترة —");
ok("رسالة فريق جديدة ⇒ تُرسل", classifyMessage(msg(), ctx()).action === "send");
ok("الصادر يُتجاوز", classifyMessage(msg({ direction: "outbound" }), ctx()).reason === "outbound");
ok("رقم مؤسسة آخر يُتجاوز", classifyMessage(msg({ business_phone_number: "+966 55 111 2222" }), ctx()).reason === "other_number");
ok("عميل (ليس من الفريق) يُتجاوز ولا يذهب للمبيعات",
  classifyMessage(msg({ contact: { id: 2, phone_number: "+966554007002" } }), ctx()).reason === "non_team");
ok("رسالة مُزامَنة سابقاً تُتجاوز", classifyMessage(msg({ id: 111 }), ctx()).reason === "already_synced");
ok("أقدم من المؤشر تُتجاوز", classifyMessage(msg({ created_at: "2026-09-14T10:00:00.000Z" }), ctx()).reason === "before_cursor");
ok("أبو فايز وعمر ضمن الفريق",
  classifyMessage(msg({ contact: { id: 3, phone_number: "0504165148" } }), ctx()).action === "send" &&
  classifyMessage(msg({ contact: { id: 4, phone_number: "+966506834579" } }), ctx()).action === "send");
ok("عضو غير نشط (غير موجود في الخريطة) يُتجاوز",
  classifyMessage(msg({ contact: { id: 5, phone_number: "+966500000000" } }), ctx()).reason === "non_team");

console.log("\n— الحمولة —");
const withPdf = intakePayload(msg({ media_url: "https://app.trypeach.ai/x/Transaction-Receipt.pdf" }), "بندر");
ok("PDF ⇒ application/pdf", withPdf.attachment_mime === "application/pdf" && withPdf.attachment_name === "Transaction-Receipt.pdf");
const withImg = intakePayload(msg({ media_url: "https://app.trypeach.ai/x/receipt.jpg", content_type: "image" }), "بندر");
ok("صورة ⇒ image/*", withImg.attachment_mime === "image/*");
ok("التعليق والوقت والمصدر", withPdf.original_message === "ديزل" && withPdf.source === "whatsapp" && withPdf.message_timestamp === "2026-09-15T21:26:37.468Z");
ok("معرّف الرسالة نص (لأجل dedup)", typeof withPdf.provider_message_id === "string" && withPdf.provider_message_id === "900");
ok("بلا مرفق ⇒ بلا حقول مرفق", intakePayload(msg({ media_url: null, content_type: "text" }), "بندر").attachment_url === undefined);

console.log("\n— إعادة المحاولة —");
ok("فشل خادم/شبكة قابل لإعادة المحاولة", isRetryable(0) && isRetryable(500) && isRetryable(503));
ok("201/200/409 ليست قابلة لإعادة المحاولة", !isRetryable(201) && !isRetryable(200) && !isRetryable(409));
ok("تطبيع الأرقام", digits("+966 54 144 9943") === "966541449943");

console.log(`\nالنتيجة: ${passed} ناجح، ${failed} فاشل`);
process.exit(failed ? 1 : 0);
