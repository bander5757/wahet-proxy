const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

function loadDotEnv(file) {
  const fullPath = path.join(process.cwd(), file);
  if (!fs.existsSync(fullPath)) return;
  const lines = fs.readFileSync(fullPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

async function runSql(pool, file) {
  const sql = fs.readFileSync(path.join(process.cwd(), file), "utf8");
  await pool.query(sql);
  console.log(`Applied ${file}`);
}

async function main() {
  loadDotEnv(".env.local");
  loadDotEnv(".env");

  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is missing. Add it to .env.local or export it in your shell.");
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
  });

  try {
    await runSql(pool, "database_schema.sql");
    if (process.argv.includes("--seed")) {
      await runSql(pool, "database_seed.sql");
    }
    console.log("Database is ready.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
