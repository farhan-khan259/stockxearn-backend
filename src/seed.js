import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { config, assertConfig } from "./config.js";
import { initialize, ensure } from "./services.js";
import { User } from "./models.js";
assertConfig();
try {
  await mongoose.connect(config.mongo);
  await initialize();
  const email = process.env.ADMIN_EMAIL || "admin@tickernest.online",
    password = process.env.ADMIN_PASSWORD;
  const syncCredentials = process.argv.includes("--sync-admin-credentials");
  ensure(
    password && password.length >= 18,
    "Set a strong ADMIN_PASSWORD of at least 18 characters",
  );
  let old = await User.findOne({ email });
  ensure(!old || old.role === "admin", "Admin email is already in use");
  if (syncCredentials && !old) {
    const admins = await User.find({ role: "admin" }).limit(2);
    ensure(
      admins.length <= 1,
      "Set ADMIN_EMAIL to an existing administrator's email before syncing credentials",
    );
    old = admins[0] || null;
  }
  if (!old) {
    await User.create({
      name: "TickerNest Administrator",
      email,
      password: await bcrypt.hash(password, 12),
      role: "admin",
      referralCode: randomBytes(6).toString("hex").toUpperCase(),
    });
    console.log(
      "Administrator created. View the initial referral code on the admin dashboard.",
    );
  } else if (syncCredentials) {
    old.email = email;
    old.password = await bcrypt.hash(password, 12);
    old.tokenVersion++;
    old.mustChangePassword = false;
    await old.save();
    console.log(
      "Administrator credentials synchronized from the environment; existing sessions invalidated.",
    );
  } else console.log("Administrator already exists; password unchanged.");
  console.log(
    "10 plans and 10 ranks initialized. No demo users or transactions.",
  );
} finally {
  await mongoose.disconnect();
}
