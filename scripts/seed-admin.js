/**
 * Create the admin account if it does not exist yet.
 * Usage (PowerShell):
 *   $env:ADMIN_BOOTSTRAP_EMAIL="you@example.com"
 *   $env:ADMIN_BOOTSTRAP_PASSWORD="your-password"
 *   $env:ADMIN_EMAILS="you@example.com"
 *   node scripts/seed-admin.js
 */
const authLib = require("../lib/auth");
const userStore = require("../lib/user-store");

async function main() {
  const email = process.env.ADMIN_BOOTSTRAP_EMAIL || process.env.ADMIN_EMAILS?.split(",")[0];
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;

  if (!email || !password) {
    console.error("Set ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD (and ADMIN_EMAILS).");
    process.exit(1);
  }

  if (!userStore.isAdminEmail(email)) {
    console.error(`Email ${email} is not listed in ADMIN_EMAILS.`);
    process.exit(1);
  }

  const forceReset = String(process.env.ADMIN_BOOTSTRAP_RESET || "").toLowerCase() === "true";
  const result = await userStore.bootstrapAdminAccount({ email, password, authLib, forceReset });
  if (result.created) {
    console.log(`Admin account created for ${email}`);
  } else if (result.reset) {
    console.log(`Admin password reset for ${email}`);
  } else if (result.reason === "exists") {
    console.log(`Account already exists for ${email} (set ADMIN_BOOTSTRAP_RESET=true to reset password)`);
  } else {
    console.error("Could not create admin account:", result.reason);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
