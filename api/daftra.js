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

  const url = `https://${subdomain}.daftra.com/api2/${endpoint}`;

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