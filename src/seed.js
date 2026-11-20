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
  const email = process.env.ADMIN_EMAIL || "admin@stockxearn.site",
    password = process.env.ADMIN_PASSWORD;
  ensure(
    password && password.length >= 18,
    "Set a strong ADMIN_PASSWORD of at least 18 characters",
  );
  const old = await User.findOne({ email });
  ensure(!old || old.role === "admin", "Admin email is already in use");
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
  } else console.log("Administrator already exists; password unchanged.");
  console.log(
    "10 plans and 10 ranks initialized. No demo users or transactions.",
  );
} finally {
  await mongoose.disconnect();
}
