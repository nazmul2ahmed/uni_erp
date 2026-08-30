import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./schema/*.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://erp:erp_dev_password@localhost:5432/erp_dev",
  },
  // Shared-mode: single database, multiple schema namespaces (control/core/...)
  // per 06_DATABASE_SPECIFICATION.md §3.
  schemaFilter: ["control", "core"],
});
