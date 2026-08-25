module.exports = async function handler(req, res) {

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "فقط POST مسموح" });
  }

  const { subdomain, apikey, endpoint, method = "GET", body } = req.body || {};

  if (!subdomain || !apikey || !endpoint) {
    return res.status(400).json({ error: "subdomain و apikey و endpoint مطلوبة" });
  }
  if (method !== "GET") {
    return res.status(405).json({ error: "وسيط دفترة يسمح بطلبات GET فقط" });
  }
  const cleanEndpoint = String(endpoint || "").replace(/^\/+/, "");
  const allowedRoots = [
    "estimates",
    "invoices",
    "expenses",
    "employee_custodies",
    "employee-custodies",
    "custodies",
    "payments",
    "receipts",
    "transactions",
    "treasuries",
    "bank_accounts",
    "accounts",
  ];
  const root = cleanEndpoint.split(/[/.?]/)[0];
  if (!allowedRoots.includes(root)) {
    return res.status(403).json({ error: "مسار دفترة غير مسموح في الوسيط" });
  }

  const url = `https://${subdomain}.daftra.com/api2/${cleanEndpoint}`;

  try {
    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "APIKEY": apikey,
      },
      ...(body && method !== "GET" ? { body: JSON.stringify(body) } : {}),
    });

    const data = await response.json();
    return res.status(response.status).json(data);

  } catch (err) {
    return res.status(500).json({ error: "فشل الاتصال بدفترة", details: err.message });
  }
};
