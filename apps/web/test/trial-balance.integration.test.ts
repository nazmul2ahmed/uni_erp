import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, journalEntries, memberships, tenants, users, withTenantTransaction } from "@erp/db";
import type { TenantContext } from "../lib/guard";
import { resolvePermissions, resolveRoleKey } from "../lib/guard";
import { registerOwnerAndTenant } from "../lib/tenant-onboarding";
import { postJournal } from "../lib/accounting";
import { getTrialBalance } from "../lib/use-cases/trial-balance";

type Fixture = { tenantId: string; userId: string; ctx: TenantContext };
let tenantA: Fixture;
let tenantB: Fixture;
let emptyTenant: Fixture;
let januaryJournalId: string;

async function provision(label: string): Promise<Fixture> {
  const registration = await registerOwnerAndTenant({
    email: `trial-balance-${label}-${randomUUID()}@example.test`,
    password: "correct horse battery staple",
    fullName: `Trial Balance ${label}`,
    businessName: `Trial Balance ${label}`,
  });
  const membership = await db.query.memberships.findFirst({ where: eq(memberships.id, registration.membershipId) });
  if (!membership) throw new Error("Owner membership was not created");
  return {
    tenantId: registration.tenantId,
    userId: registration.userId,
    ctx: {
      requestId: randomUUID(),
      userId: registration.userId,
      tenantId: registration.tenantId,
      membershipId: registration.membershipId,
      roleId: membership.roleId,
      storageMode: "SHARED",
      permissions: await resolvePermissions(membership.roleId),
      roleKey: await resolveRoleKey(membership.roleId),
    },
  };
}

async function postOpeningJournal(fixture: Fixture, debitCode: string, amount: string, postedAt: Date) {
  return withTenantTransaction(fixture.tenantId, (tx) =>
    postJournal(tx, fixture.ctx, {
      referenceType: "TEST_OPENING",
      referenceId: randomUUID(),
      description: "Trial balance integration fixture",
      operationId: randomUUID(),
      postedAt,
      lines: [
        { code: debitCode, debit: amount },
        { code: "3000", credit: amount },
      ],
    }),
  );
}

beforeAll(async () => {
  tenantA = await provision("A");
  tenantB = await provision("B");
  emptyTenant = await provision("Empty");

  const january = await postOpeningJournal(tenantA, "1000", "100.1234", new Date("2026-01-31T23:59:59.999Z"));
  januaryJournalId = january.id;
  await postOpeningJournal(tenantA, "1010", "25.0000", new Date("2026-02-01T00:00:00.000Z"));
  await postOpeningJournal(tenantB, "1000", "900.0000", new Date("2026-01-15T12:00:00.000Z"));
}, 90_000);

afterAll(async () => {
  for (const fixture of [tenantA, tenantB, emptyTenant]) {
    if (!fixture) continue;
    await db.delete(tenants).where(eq(tenants.id, fixture.tenantId));
    await db.delete(users).where(eq(users.id, fixture.userId));
  }
});

describe("getTrialBalance -- 08 §6.1", () => {
  it("aggregates exact per-account debits and credits for an inclusive date range", async () => {
    const report = await getTrialBalance(tenantA.ctx, { dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    expect(report.period).toEqual({ dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    expect(report.lines).toEqual([
      { code: "1000", name: "Cash", type: "ASSET", debit: "100.1234", credit: "0" },
      { code: "3000", name: "Owner Equity", type: "EQUITY", debit: "0", credit: "100.1234" },
    ]);
    expect(report.totals).toEqual({ debit: "100.1234", credit: "100.1234" });
  });

  it("isolates tenants and returns an empty, balanced result for a tenant with no journals", async () => {
    const otherTenant = await getTrialBalance(tenantB.ctx, { dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    expect(otherTenant.totals).toEqual({ debit: "900", credit: "900" });
    expect(otherTenant.lines.map((line) => line.code)).toEqual(["1000", "3000"]);

    const empty = await getTrialBalance(emptyTenant.ctx);
    expect(empty).toMatchObject({ lines: [], totals: { debit: "0", credit: "0" } });
  });

  it("logs and surfaces an integrity error if the selected ledger is unbalanced", async () => {
    const logger = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let creditEntryId: string | undefined;
    let originalCredit: string | undefined;
    try {
      await withTenantTransaction(tenantA.tenantId, async (tx) => {
        const entries = await tx.query.journalEntries.findMany({ where: eq(journalEntries.journalId, januaryJournalId) });
        const creditEntry = entries.find((entry) => BigInt(entry.credit.replace(".", "")) > 0n);
        if (!creditEntry) throw new Error("Fixture journal has no credit entry");
        creditEntryId = creditEntry.id;
        originalCredit = creditEntry.credit;
        await tx.update(journalEntries).set({ credit: "100.1235" }).where(eq(journalEntries.id, creditEntry.id));
      });

      await expect(getTrialBalance(tenantA.ctx, { dateFrom: "2026-01-01", dateTo: "2026-01-31" }))
        .rejects.toMatchObject({ code: "UNBALANCED_JOURNAL" });
      expect(logger).toHaveBeenCalledWith(
        "Accounting integrity incident: trial balance is out of balance",
        expect.objectContaining({ totalDebit: "100.1234", totalCredit: "100.1235" }),
      );
    } finally {
      if (creditEntryId && originalCredit) {
        await withTenantTransaction(tenantA.tenantId, (tx) =>
          tx.update(journalEntries).set({ credit: originalCredit! }).where(eq(journalEntries.id, creditEntryId!)),
        );
      }
      logger.mockRestore();
    }
  });
});
