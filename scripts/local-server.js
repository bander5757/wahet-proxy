const fs = require("fs");
const http = require("http");
const path = require("path");

function loadDotEnv(file) {
  const fullPath = path.join(process.cwd(), file);
  if (!fs.existsSync(fullPath)) return;
  for (const line of fs.readFileSync(fullPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadDotEnv(".env.local");
loadDotEnv(".env");

const appHandler = require("../api/app");
const daftraHandler = require("../api/daftra");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 5_000_000) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

function decorateResponse(res) {
  res.status = code => {
    res.statusCode = code;
    return res;
  };
  res.json = payload => {
    if (!res.getHeader("Content-Type")) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
    }
    res.end(JSON.stringify(payload));
  };
  return res;
}

async function routeApi(req, res, url) {
  req.body = await readBody(req);
  req.query = {};
  if (url.pathname.startsWith("/api/app")) {
    req.query.path = url.pathname.replace("/api/app", "") || "/bootstrap";
    return appHandler(req, decorateResponse(res));
  }
  if (url.pathname === "/api/daftra") {
    return daftraHandler(req, decorateResponse(res));
  }
  res.statusCode = 404;
  res.end("Not found");
}

function serveStatic(res, url) {
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const fullPath = path.join(process.cwd(), requested);
  if (!fullPath.startsWith(process.cwd()) || !fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
    res.setHeader("Content-Type", MIME[".html"]);
    res.end(fs.readFileSync(path.join(process.cwd(), "index.html")));
    return;
  }
  res.setHeader("Content-Type", MIME[path.extname(fullPath)] || "application/octet-stream");
  res.end(fs.readFileSync(fullPath));
}

const port = Number(process.env.PORT || 4174);
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) return await routeApi(req, res, url);
    serveStatic(res, url);
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
});

server.listen(port, () => {
  console.log(`Wahet local app running at http://localhost:${port}`);
});
