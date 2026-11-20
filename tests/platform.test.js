import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { MongoMemoryReplSet } from "mongodb-memory-server";
process.env.JWT_SECRET =
  "test-only-secret-for-stockxearn-integration-testing-1234567890";
process.env.NODE_ENV = "test";
process.env.UPLOAD_DIR = "/tmp/stockxearn-test-uploads";
const M = await import("../src/models.js");
const S = await import("../src/services.js");
const { DAY, PLAN_DATA } = await import("../src/catalog.js");
const {
  User,
  Plan,
  Purchase,
  Earning,
  Transaction,
  Deposit,
  Setting,
  Rank,
  RankClaim,
  RewardCode,
  Redemption,
  Community,
  Audit,
  Content,
} = M;
let db,
  dbPath,
  app,
  admin,
  adminToken,
  counter = 0;
const password = "SxTesting!12345",
  key = randomUUID;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6rHkAAAAASUVORK5CYII=",
  "base64",
);
async function member(parent) {
  counter++;
  return User.create({
    name: "Integration member",
    phone: `0300${String(counter).padStart(7, "0")}`,
    password: await bcrypt.hash(password, 4),
    referralCode: `TEST${counter}`,
    referredBy: parent,
  });
}
async function login(u, isAdmin = false) {
  const r = await request(app)
    .post("/api/auth/login")
    .send(
      isAdmin
        ? { admin: true, email: u.email, password }
        : { phone: u.phone, password },
    );
  assert.equal(r.status, 200, r.text);
  return r.body.token;
}
const adminReq = (method, path) =>
  request(app)[method](path).auth(adminToken, { type: "bearer" });
before(async () => {
  dbPath = await mkdtemp(path.join(process.cwd(), ".test-mongo-"));
  db = await MongoMemoryReplSet.create({
    instanceOpts: [{ dbPath, args: ["--nounixsocket"] }],
    replSet: { count: 1 },
    binary: { version: "7.0.24" },
  });
  await mongoose.connect(db.getUri("stockxearn-tests"));
  await S.initialize();
  ({ app } = await import("../src/app.js"));
  admin = await User.create({
    name: "Test Admin",
    email: "admin@test.local",
    password: await bcrypt.hash(password, 4),
    role: "admin",
    referralCode: "ADMININVITE",
  });
  adminToken = await login(admin, true);
});
after(async () => {
  await mongoose.disconnect();
  if (db) await db.stop();
  if (dbPath) await rm(dbPath, { recursive: true, force: true });
});
test("10 exact USD plans, 60 payout totals and initial locks; initialization preserves admin edits", async () => {
  assert.equal(await Plan.countDocuments(), 10);
  assert.equal(await Rank.countDocuments(), 10);
  assert.deepEqual(
    PLAN_DATA.map((p) => p.price),
    [3, 5, 10, 20, 30, 50, 80, 100, 200, 500].map(
      (n) => n * 100,
    ),
  );
  for (const [index, p] of PLAN_DATA.entries()) {
    assert.equal(p.duration, 60);
    assert.equal(p.daily, p.price / 10);
    assert.equal(p.total, p.daily * p.duration);
    assert.equal(p.locked, index >= 5);
  }
  const p = await Plan.findOne({ code: "SX01" });
  await Plan.updateOne(
    { _id: p._id },
    { $set: { price: 1, daily: 1, total: 1, duration: 1, catalogVersion: 1 } },
  );
  await S.initialize();
  const migrated = await Plan.findById(p._id);
  assert.equal(migrated.price, 300);
  assert.equal(migrated.daily, 30);
  assert.equal(migrated.total, 1800);
  assert.equal(migrated.duration, 60);
  await Plan.updateOne({ _id: p._id }, { $set: { name: "Edited name" } });
  await S.initialize();
  assert.equal((await Plan.findById(p._id)).name, "Edited name");
  await Plan.updateOne({ _id: p._id }, { $set: { name: "Market Starter" } });
});
test("initialization updates old default brand copy without replacing custom content", async () => {
  await Content.updateOne(
    { key: "site" },
    {
      $set: {
        heroTitle: "Custom hero title",
        heroSubtitle:
          "Meet StockXEarn. A privately operated investment platform with a clear member workspace, transparent records, and personal support.",
        "faqs.1.answer":
          "Deposit funds are designed for plan purchases and cannot be withdrawn directly. Profits, commissions and rewards can be withdrawn when you have an active plan and meet the $1 minimum. StockXEarn does not charge a withdrawal fee.",
        popupTitle: "StockXEarn launches 20 November 2026",
        popupBody:
          "We are excited to welcome you to StockXEarn. Join our WhatsApp channel for launch updates and important member announcements.",
      },
    },
  );
  await S.initialize();
  let content = await Content.findOne({ key: "site" }).lean();
  assert.equal(content.heroTitle, "Custom hero title");
  assert.match(content.heroSubtitle, /TickerNest/);
  assert.match(content.faqs[1].answer, /TickerNest/);
  assert.match(content.popupTitle, /TickerNest/);
  assert.match(content.popupBody, /TickerNest/);

  await Content.updateOne(
    { key: "site" },
    {
      $set: {
        heroSubtitle: "Custom subtitle",
        "faqs.1.answer": "Custom FAQ answer",
        popupTitle: "Custom popup title",
        popupBody: "Custom popup body",
      },
    },
  );
  await S.initialize();
  content = await Content.findOne({ key: "site" }).lean();
  assert.equal(content.heroSubtitle, "Custom subtitle");
  assert.equal(content.faqs[1].answer, "Custom FAQ answer");
  assert.equal(content.popupTitle, "Custom popup title");
  assert.equal(content.popupBody, "Custom popup body");
});
test("public APIs do not expose plan or payment account details", async () => {
  assert.equal((await request(app).get("/api/plans")).status, 401);
  const r = await request(app).get("/api/public/settings");
  assert.equal(r.status, 200);
  assert.ok(!r.body.accountNumber);
  assert.deepEqual(
    Object.keys((await request(app).get("/api/public/content")).body).sort(),
    ["heroSubtitle", "heroTitle"],
  );
});
test("registration requires referral, consent, matching passwords and normalizes mobile", async () => {
  const d = {
    name: "New member",
    phone: "+923991110001",
    password,
    confirmPassword: password,
    referralCode: "ADMININVITE",
    terms: true,
  };
  for (const bad of [
    { referralCode: "" },
    { terms: false },
    { confirmPassword: "differentpass" },
  ])
    assert.equal(
      (
        await request(app)
          .post("/api/auth/register")
          .send({ ...d, ...bad })
      ).status,
      400,
    );
  const r = await request(app).post("/api/auth/register").send(d);
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.user.phone, "03991110001");
  assert.equal(
    (
      await request(app)
        .post("/api/auth/register")
        .send({ ...d, phone: "03991110001" })
    ).status,
    409,
  );
});
test("approved PKR deposits credit USD wallets and pay 8/5/2 once", async () => {
  const a = await member(),
    b = await member(a._id),
    c = await member(b._id),
    u = await member(c._id);
  await User.updateOne({ _id: c._id }, { $set: { blocked: true } });
  const d = await Deposit.create({
    user: u._id,
    amount: 100000,
    method: "jazzcash",
    tid: key(),
    screenshot: "test",
    mime: "image/png",
  });
  await S.reviewDeposit(d._id, admin._id, "approved", "verified");
  assert.equal((await User.findById(u._id)).depositBalance, 357);
  for (const [x, n] of [
    [c, 28],
    [b, 17],
    [a, 7],
  ])
    assert.equal((await User.findById(x._id)).withdrawableBalance, n);
  await assert.rejects(
    () => S.reviewDeposit(d._id, admin._id, "approved", ""),
    /Already reviewed/,
  );
  assert.equal(
    await Transaction.countDocuments({
      kind: "commission",
      reference: { $regex: `^${d._id}:` },
    }),
    3,
  );
});
test("purchase uses deposits, first payout after 24h, unlimited purchases and exact final totals", async () => {
  const u = await member(),
    p = await Plan.findOne({ code: "SX02" });
  await User.updateOne(
    { _id: u._id },
    { $set: { withdrawableBalance: 10000000 } },
  );
  await assert.rejects(() => S.buyPlan(u._id, p._id, key()), /Insufficient/);
  await User.updateOne(
    { _id: u._id },
    { $set: { depositBalance: p.price * 3 } },
  );
  const k = key(),
    purchase = await S.buyPlan(u._id, p._id, k);
  assert.equal(purchase.creditedDays, 0);
  assert.equal(await Earning.countDocuments({ purchase: purchase._id }), 0);
  assert.equal(
    String((await S.buyPlan(u._id, p._id, k))._id),
    String(purchase._id),
  );
  await S.buyPlan(u._id, p._id, key());
  assert.equal(await Purchase.countDocuments({ user: u._id }), 2);
  await S.runEarnings(new Date(+purchase.nextCreditAt - 1));
  assert.equal((await Purchase.findById(purchase._id)).creditedDays, 0);
  await S.runEarnings(new Date(+purchase.nextCreditAt));
  assert.equal((await Purchase.findById(purchase._id)).creditedDays, 1);
  await S.runEarnings(new Date(+purchase.endsAt + DAY));
  const done = await Purchase.findById(purchase._id);
  assert.equal(done.status, "completed");
  assert.equal(done.paid, p.total);
  assert.equal(done.creditedDays, 60);
  assert.equal(
    (await User.findById(u._id)).withdrawableBalance,
    10000000 + p.total * 2,
  );
  await S.runEarnings(new Date(+purchase.endsAt + DAY));
  assert.equal(await Earning.countDocuments({ purchase: purchase._id }), 60);
});
test("locked plans remain visible but cannot be purchased until an admin unlocks them", async () => {
  const u = await member(),
    token = await login(u),
    plan = await Plan.findOne({ code: "SX06" });
  await User.updateOne({ _id: u._id }, { $set: { depositBalance: plan.price } });

  const visible = await request(app)
    .get("/api/plans")
    .auth(token, { type: "bearer" });
  assert.equal(visible.status, 200, visible.text);
  assert.equal(
    visible.body.find((p) => p.code === "SX06").locked,
    true,
  );
  const locked = await request(app)
    .post("/api/purchases")
    .auth(token, { type: "bearer" })
    .set("Idempotency-Key", key())
    .send({ planId: plan._id });
  assert.equal(locked.status, 409, locked.text);
  assert.match(locked.body.message, /available soon/i);

  const unlock = await adminReq("patch", `/api/admin/plans/${plan._id}`).send({
    name: plan.name,
    description: plan.description,
    image: plan.image,
    price: plan.price / 100,
    daily: plan.daily / 100,
    duration: plan.duration,
    enabled: true,
    locked: false,
  });
  assert.equal(unlock.status, 200, unlock.text);
  assert.equal(unlock.body.total, unlock.body.daily * unlock.body.duration);
  const purchased = await request(app)
    .post("/api/purchases")
    .auth(token, { type: "bearer" })
    .set("Idempotency-Key", key())
    .send({ planId: plan._id });
  assert.equal(purchased.status, 201, purchased.text);

  const relock = await adminReq("patch", `/api/admin/plans/${plan._id}`).send({
    name: plan.name,
    description: plan.description,
    image: plan.image,
    price: plan.price / 100,
    daily: plan.daily / 100,
    duration: plan.duration,
    enabled: true,
    locked: true,
  });
  assert.equal(relock.status, 200, relock.text);
  await User.updateOne({ _id: u._id }, { $set: { depositBalance: plan.price } });
  const blockedAgain = await request(app)
    .post("/api/purchases")
    .auth(token, { type: "bearer" })
    .set("Idempotency-Key", key())
    .send({ planId: plan._id });
  assert.equal(blockedAgain.status, 409, blockedAgain.text);
});
test("competing schedulers do not double-credit; blocked user continues earning", async () => {
  const u = await member(),
    p = await Plan.findOne({ code: "SX01" });
  await User.updateOne({ _id: u._id }, { $set: { depositBalance: 42000 } });
  const purchase = await S.buyPlan(u._id, p._id, key());
  await User.updateOne({ _id: u._id }, { $set: { blocked: true } });
  await Promise.all([
    S.runEarnings(new Date(+purchase.endsAt)),
    S.runEarnings(new Date(+purchase.endsAt)),
  ]);
  assert.equal((await Purchase.findById(purchase._id)).paid, p.total);
  assert.equal(await Earning.countDocuments({ purchase: purchase._id }), 60);
  assert.equal((await User.findById(u._id)).withdrawableBalance, p.total);
});
test("withdrawals need active plan; reserve earnings only and refund rejection once", async () => {
  const u = await member();
  await User.updateOne(
    { _id: u._id },
    { $set: { depositBalance: 100000, withdrawableBalance: 20000 } },
  );
  const d = {
    amount: 10000,
    institution: "easypaisa",
    accountName: "Test",
    accountNumber: u.phone,
  };
  await assert.rejects(
    () => S.requestWithdrawal(u._id, d, key()),
    /active plan/,
  );
  await S.buyPlan(u._id, (await Plan.findOne({ code: "SX01" }))._id, key());
  const w = await S.requestWithdrawal(u._id, d, key());
  assert.equal((await User.findById(u._id)).withdrawableBalance, 10000);
  await S.reviewWithdrawal(w._id, admin._id, "rejected", "Invalid account");
  assert.equal((await User.findById(u._id)).withdrawableBalance, 20000);
  await assert.rejects(
    () => S.reviewWithdrawal(w._id, admin._id, "rejected", ""),
    /Already reviewed/,
  );
});
test("payment APIs enforce minimums and image signatures", async () => {
  const u = await member(),
    token = await login(u);
  const deposit = (n, buf = png) =>
    request(app)
      .post("/api/deposits")
      .auth(token, { type: "bearer" })
      .field("amount", String(n))
      .field("method", "jazzcash")
      .field("tid", key())
      .attach("screenshot", buf, {
        filename: "proof.png",
        contentType: "image/png",
      });
  assert.equal((await deposit(2.99)).status, 400);
  const ok = await deposit(3);
  assert.equal(ok.status, 201, ok.text);
  assert.equal((await deposit(3, Buffer.from("not an image"))).status, 400);
  assert.equal(
    (
      await request(app)
        .post("/api/withdrawals")
        .auth(token, { type: "bearer" })
        .set("Idempotency-Key", key())
        .send({
          amount: 0.99,
          institution: "easypaisa",
          accountName: "Test",
          accountNumber: u.phone,
        })
    ).status,
    400,
  );
});
test("parallel code claims cannot exceed cap; each user can redeem once", async () => {
  const users = [];
  for (let i = 0; i < 4; i++) users.push(await member());
  const c = await RewardCode.create({
    code: "FIRST-TWO",
    amount: 5000,
    expiresAt: new Date(Date.now() + DAY),
    limit: 2,
  });
  const out = await Promise.allSettled(
    users.map((u) => S.redeem(u._id, c.code)),
  );
  assert.equal(out.filter((x) => x.status === "fulfilled").length, 2);
  assert.equal((await RewardCode.findById(c._id)).used, 2);
  assert.equal(await Redemption.countDocuments({ code: c._id }), 2);
  const d = await RewardCode.create({
    code: "ONCE",
    amount: 1000,
    expiresAt: new Date(Date.now() + DAY),
    limit: 30,
  });
  await S.redeem(users[0]._id, d.code);
  await assert.rejects(
    () => S.redeem(users[0]._id, d.code),
    /already redeemed/,
  );
  assert.equal((await RewardCode.findById(d._id)).used, 1);
  const token = await login(users[0]);
  const history = await request(app)
    .get("/api/reward-codes/history")
    .auth(token, { type: "bearer" });
  assert.equal(history.status, 200);
  assert.equal(history.body.items[0].code.code, d.code);
});
test("ranks count all lifetime purchases in exactly 3 team levels; all eligible ranks claim once", async () => {
  const u = await member(),
    a = await member(u._id),
    b = await member(a._id),
    c = await member(b._id),
    four = await member(c._id),
    plan = await Plan.findOne({ code: "SX01" });
  for (const [m, price] of [
    [u, 5000000],
    [a, 10000000],
    [b, 20000000],
    [c, 20000000],
    [four, 99999999],
  ])
    await Purchase.create({
      user: m._id,
      plan: plan._id,
      name: plan.name,
      price,
      daily: 1,
      total: 30,
      duration: 30,
      paid: 30,
      creditedDays: 30,
      status: "completed",
      requestKey: key(),
    });
  const p = await S.rankProgress(u._id);
  assert.equal(p.personal, 5000000);
  assert.equal(p.team, 50000000);
  assert.equal(p.ranks.filter((r) => r.qualified).length, 10);
  const ranks = await Rank.find().sort({ level: 1 });
  for (const r of ranks) await S.claimRank(u._id, String(r._id));
  assert.equal(await RankClaim.countDocuments({ user: u._id }), 10);
  assert.equal(
    (await User.findById(u._id)).withdrawableBalance,
    ranks.reduce((n, r) => n + r.reward, 0),
  );
  await assert.rejects(
    () => S.claimRank(u._id, String(ranks[0]._id)),
    /already claimed/,
  );
});
test("community allows one attempt, permanent rejection, one approval credit", async () => {
  const u = await member(),
    token = await login(u);
  const submit = () =>
    request(app)
      .post("/api/community")
      .auth(token, { type: "bearer" })
      .attach("screenshot", png, "proof.png");
  const r = await submit();
  assert.equal(r.status, 201, r.text);
  await S.reviewCommunity(r.body._id, admin._id, "rejected", "Not joined");
  assert.equal((await submit()).status, 409);
  assert.equal((await User.findById(u._id)).withdrawableBalance, 0);
  const v = await member(),
    c = await Community.create({
      user: v._id,
      screenshot: "test",
      mime: "image/png",
    });
  await S.reviewCommunity(c._id, admin._id, "approved", "");
  await assert.rejects(
    () => S.reviewCommunity(c._id, admin._id, "approved", ""),
    /Already reviewed/,
  );
  assert.equal((await User.findById(v._id)).withdrawableBalance, 10);
});
test("only admin can change phone; impersonation is bound to admin and audited", async () => {
  const u = await member(),
    token = await login(u);
  assert.equal(
    (
      await request(app)
        .patch("/api/me")
        .auth(token, { type: "bearer" })
        .send({ name: "Test", phone: "03009999999" })
    ).status,
    400,
  );
  assert.equal(
    (await request(app).get("/api/admin/users").auth(token, { type: "bearer" }))
      .status,
    403,
  );
  const access = await adminReq("post", `/api/admin/users/${u._id}/login`);
  assert.equal(access.status, 200);
  const t = access.body.token;
  assert.equal(
    (await request(app).get("/api/me").auth(t, { type: "bearer" })).body
      .impersonating,
    true,
  );
  assert.equal(
    (
      await request(app)
        .patch("/api/me")
        .auth(t, { type: "bearer" })
        .send({ name: "Admin edited" })
    ).status,
    200,
  );
  assert.ok(
    await Audit.exists({
      actor: admin._id,
      target: u._id,
      "details.impersonated": true,
    }),
  );
  assert.equal(
    (await request(app).get("/api/admin/users").auth(t, { type: "bearer" }))
      .status,
    403,
  );
});
test("balance adjustments require reason and concurrent deductions cannot overdraw", async () => {
  const u = await member(),
    path = `/api/admin/users/${u._id}/balance`,
    call = (d) => adminReq("post", path).send(d);
  assert.equal(
    (await call({ wallet: "deposit", direction: "add", amount: 100 })).status,
    400,
  );
  assert.equal(
    (
      await call({
        wallet: "deposit",
        direction: "add",
        amount: 100,
        reason: "Verified correction",
      })
    ).status,
    200,
  );
  const out = await Promise.all([
    call({
      wallet: "deposit",
      direction: "remove",
      amount: 100,
      reason: "Remove correction",
    }),
    call({
      wallet: "deposit",
      direction: "remove",
      amount: 100,
      reason: "Remove correction",
    }),
  ]);
  assert.equal(out.filter((r) => r.status === 200).length, 1);
  assert.equal((await User.findById(u._id)).depositBalance, 0);
});
test("temporary password ends old sessions and forces change; blocked users cannot log in", async () => {
  const u = await member(),
    token = await login(u),
    r = await adminReq("post", `/api/admin/users/${u._id}/reset-password`);
  assert.equal(r.status, 200);
  assert.equal(
    (await request(app).get("/api/me").auth(token, { type: "bearer" })).status,
    401,
  );
  const l = await request(app)
    .post("/api/auth/login")
    .send({ phone: u.phone, password: r.body.temporaryPassword });
  assert.equal(l.status, 200);
  assert.equal(l.body.user.mustChangePassword, true);
  assert.equal(
    (
      await request(app)
        .get("/api/plans")
        .auth(l.body.token, { type: "bearer" })
    ).status,
    403,
  );
  const c = await request(app)
    .post("/api/me/password")
    .auth(l.body.token, { type: "bearer" })
    .send({ currentPassword: r.body.temporaryPassword, newPassword: password });
  assert.equal(c.status, 200, c.text);
  assert.equal(c.body.user.mustChangePassword, false);
  await adminReq("patch", `/api/admin/users/${u._id}`).send({ blocked: true });
  assert.equal(
    (await request(app).get("/api/me").auth(c.body.token, { type: "bearer" }))
      .status,
    401,
  );
  assert.equal(
    (
      await request(app)
        .post("/api/auth/login")
        .send({ phone: u.phone, password })
    ).status,
    401,
  );
});
test("edited plan keeps old purchase terms; popup revision increases", async () => {
  const u = await member(),
    p = await Plan.findOne({ code: "SX01" });
  await User.updateOne({ _id: u._id }, { $set: { depositBalance: p.price } });
  const purchase = await S.buyPlan(u._id, p._id, key());
  const e = await adminReq("patch", `/api/admin/plans/${p._id}`).send({
    name: p.name,
    description: p.description,
    image: p.image,
    price: 500,
    daily: 50,
    duration: 60,
    enabled: true,
    locked: false,
  });
  assert.equal(e.status, 200, e.text);
  assert.equal((await Purchase.findById(purchase._id)).price, 300);
  const content = (await adminReq("get", "/api/admin/content")).body;
  const out = await adminReq("patch", "/api/admin/content").send({
    ...content,
    popupBody: "A newly published welcome message",
  });
  assert.equal(out.status, 200, out.text);
  assert.equal(out.body.popupVersion, content.popupVersion + 1);
});
