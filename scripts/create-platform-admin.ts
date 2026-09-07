import { hashPassword } from "../src/infrastructure/auth/password";
import { getDb } from "../src/infrastructure/db/client";
import { platformAdmins } from "../src/infrastructure/db/schema";

async function main() {
  const [email, fullName, password] = process.argv.slice(2);
  if (!email || !fullName || !password || password.length < 10) {
    throw new Error("Usage: npx tsx scripts/create-platform-admin.ts <email> <full-name> <password> (password must be at least 10 characters)");
  }
  const db = await getDb();
  await db.insert(platformAdmins).values({ email: email.toLowerCase().trim(), fullName, passwordHash: await hashPassword(password) });
  console.log(`Platform admin created for ${email.toLowerCase().trim()}.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
