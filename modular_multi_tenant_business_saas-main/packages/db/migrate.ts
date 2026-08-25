import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const connectionString =
  process.env.DATABASE_URL ?? "postgres://erp:erp_dev_password@localhost:5432/erp_dev";

async function main() {
  const sql = postgres(connectionString, { max: 1 });
  const db = drizzle(sql);

  console.log("[db] running drizzle-kit generated migrations...");
  await migrate(db, { migrationsFolder: "./migrations" });

  console.log("[db] applying manual RLS policy migrations...");
  const manualDir = "./migrations-manual";
  const files = readdirSync(manualDir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const content = readFileSync(join(manualDir, file), "utf-8");
    console.log(`  -> ${file}`);
    await sql.unsafe(content);
  }

  console.log("[db] migrations complete.");
  await sql.end();
}

main().catch((e) => {
  console.error("[db] migration failed:", e);
  process.exit(1);
});
