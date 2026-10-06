/**
 * Platform-operator CLI (ADR-001). Runs as the database OWNER role (DATABASE_URL),
 * the only role allowed to create or revoke operators. Never exposed over HTTP.
 *
 *   pnpm operator:create --email ops@example.com --name "Ops Admin"   (new account, no workspace)
 *   pnpm operator:grant  --email ops@example.com                      (existing membership-free account)
 *   pnpm operator:revoke --email ops@example.com
 *   pnpm operator:reset-password --email ops@example.com   (lost password: new one-time password, all sessions revoked)
 *   pnpm operator:list
 */
import { userInfo } from "node:os";
import { createOwnerDb } from "@erp/db";
import { createOperatorAccount, grantOperator, listOperators, resetOperatorPassword, revokeOperator } from "../lib/platform-operator-admin";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const command = process.argv[2];
  const by = `cli:${userInfo().username}`;
  const { db, close } = createOwnerDb();
  try {
    const email = arg("email");
    switch (command) {
      case "create": {
        const name = arg("name");
        if (!email || !name) throw new Error('Usage: operator create --email <email> --name "<full name>"');
        const result = await createOperatorAccount(db, email, name, by);
        console.log(`Operator account created: ${result.email}`);
        console.log(`Temporary password (shown ONCE, store it in a password manager): ${result.temporaryPassword}`);
        break;
      }
      case "grant": {
        if (!email) throw new Error("Usage: operator grant --email <email>");
        const result = await grantOperator(db, email, by, arg("note"));
        console.log(result.alreadyActive ? `${result.email} is already an active operator` : `Granted operator access to ${result.email}`);
        break;
      }
      case "revoke": {
        if (!email) throw new Error("Usage: operator revoke --email <email>");
        const result = await revokeOperator(db, email, by);
        console.log(result.alreadyRevoked ? `${result.email} was already revoked` : `Revoked operator access for ${result.email} (effective on their next request)`);
        break;
      }
      case "reset-password": {
        if (!email) throw new Error("Usage: operator reset-password --email <email>");
        const result = await resetOperatorPassword(db, email, by);
        console.log(`Password reset for ${result.email}; ${result.sessionsRevoked} session(s) revoked. They must change it at next sign-in.`);
        console.log(`Temporary password (shown ONCE, store it in a password manager): ${result.temporaryPassword}`);
        break;
      }
      case "list": {
        const rows = await listOperators(db);
        if (rows.length === 0) console.log("No platform operators.");
        for (const r of rows) console.log(`${r.status.padEnd(8)} ${r.email}  (${r.fullName})  granted ${r.grantedAt.toISOString()} by ${r.grantedBy}${r.revokedAt ? `  revoked ${r.revokedAt.toISOString()}` : ""}`);
        break;
      }
      default:
        throw new Error("Usage: operator <create|grant|revoke|reset-password|list> [--email <email>] [--name <name>]");
    }
  } finally {
    await close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
