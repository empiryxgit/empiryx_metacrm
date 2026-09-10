// Data access for Platform Admin "Packages" (editable pricing config) - see
// platformPackages/platformBillingCycleDiscounts' own doc comments in
// schema.ts for the full row shape, and src/application/pricing.ts for the
// only place that ever reads these through resolvePricingConfig(). Same
// "repository trusts its caller" split every other repository in this
// codebase follows - validation (is this a real AccountType/BillingCycle,
// are the numbers non-negative) happens one layer up in
// src/application/platformAdmin.ts, never here.

import { asc, eq } from "drizzle-orm";
import { getDb } from "../client";
import { platformBillingCycleDiscounts, platformPackages } from "../schema";
import { firstOrThrow } from "../util";

export async function listPlatformPackages() {
  const db = await getDb();
  return db.select().from(platformPackages).orderBy(asc(platformPackages.accountType));
}

export async function getPlatformPackageByAccountType(accountType: string) {
  const db = await getDb();
  const [row] = await db.select().from(platformPackages).where(eq(platformPackages.accountType, accountType)).limit(1);
  return row ?? null;
}

/** Insert-or-update by accountType (UNIQUE - see this table's own index in
 * schema.ts) - an admin edit always targets "the one package for this
 * account type", never a new row, so this is always exactly one live row
 * per AccountType, same as a real upsert. */
export async function upsertPlatformPackage(input: {
  accountType: string;
  baseMonthlyPaise: number;
  baseCampaignLimit: number;
  baseClientLimit: number | null;
  overageUnitMonthlyPaise: number;
  updatedBy: string;
}) {
  const db = await getDb();
  const rows = await db
    .insert(platformPackages)
    .values({
      accountType: input.accountType,
      baseMonthlyPaise: input.baseMonthlyPaise,
      baseCampaignLimit: input.baseCampaignLimit,
      baseClientLimit: input.baseClientLimit,
      overageUnitMonthlyPaise: input.overageUnitMonthlyPaise,
      updatedBy: input.updatedBy,
    })
    .onConflictDoUpdate({
      target: platformPackages.accountType,
      set: {
        baseMonthlyPaise: input.baseMonthlyPaise,
        baseCampaignLimit: input.baseCampaignLimit,
        baseClientLimit: input.baseClientLimit,
        overageUnitMonthlyPaise: input.overageUnitMonthlyPaise,
        updatedBy: input.updatedBy,
        updatedAt: new Date(),
      },
    })
    .returning();
  return firstOrThrow(rows);
}

export async function listCycleDiscounts() {
  const db = await getDb();
  return db.select().from(platformBillingCycleDiscounts).orderBy(asc(platformBillingCycleDiscounts.cycle));
}

export async function upsertCycleDiscount(input: { cycle: string; discountPercent: number; updatedBy: string }) {
  const db = await getDb();
  const rows = await db
    .insert(platformBillingCycleDiscounts)
    .values({ cycle: input.cycle, discountPercent: input.discountPercent, updatedBy: input.updatedBy })
    .onConflictDoUpdate({
      target: platformBillingCycleDiscounts.cycle,
      set: { discountPercent: input.discountPercent, updatedBy: input.updatedBy, updatedAt: new Date() },
    })
    .returning();
  return firstOrThrow(rows);
}
