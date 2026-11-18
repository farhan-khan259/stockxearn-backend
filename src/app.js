import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import multer from "multer";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { z } from "zod";
import { config } from "./config.js";
import {
  User,
  Plan,
  Purchase,
  Earning,
  Transaction,
  Deposit,
  Withdrawal,
  Setting,
  Rank,
  RankClaim,
  RewardCode,
  Redemption,
  Community,
  Audit,
  Notification,
  Ticket,
  Content,
  Media,
} from "./models.js";
import { INSTITUTIONS } from "./catalog.js";
import {
  ensure,
  atomic,
  buyPlan,
  reviewDeposit,
  requestWithdrawal,
  reviewWithdrawal,
  reviewCommunity,
  rankProgress,
  claimRank,
  redeem,
  teamLevels,
  ledger,
  notify,
} from "./services.js";
export const app = express();
app.disable("x-powered-by");
app.set("trust proxy", process.env.TRUST_PROXY === "1" ? 1 : false);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "blob:", "data:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        upgradeInsecureRequests:
          process.env.NODE_ENV === "production" ? [] : null,
      },
    },
  }),
);
app.use(
  cors({
    origin: config.origin,
    allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
  }),
);
app.use(express.json({ limit: "256kb" }));
app.use(
  "/api",
  rateLimit({
    windowMs: 60000,
    limit: process.env.NODE_ENV === "test" ? 10000 : 300,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  }),
);
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
const id = z.string().regex(/^[a-f\d]{24}$/i);
const txt = z.string().trim().min(1).max(160);
const cash = z
  .number()
  .finite()
  .positive()
  .max(10000000)
  .refine(
    (n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6,
    "Use at most two decimal places",
  )
  .transform((n) => Math.round(n * 100));
const pwd = z.string().min(10).max(128);
export function normalizePhone(v) {
  let p = v.replace(/[ ()-]/g, "");
  if (p.startsWith("+92")) p = "0" + p.slice(3);
  else if (p.startsWith("0092")) p = "0" + p.slice(4);
  else if (p.startsWith("92")) p = "0" + p.slice(2);
  return p;
}
const phone = z
  .string()
  .trim()
  .transform(normalizePhone)
  .pipe(z.string().regex(/^03\d{9}$/, "Use a valid Pakistani mobile number"));
const email = z.string().trim().toLowerCase().email();
const link = z
  .string()
  .max(500)
  .refine(
    (v) =>
      !v || /^\/(?!\/)[a-zA-Z0-9/?#=&%._~-]*$/.test(v) || /^https:\/\//.test(v),
    "Use a local path or HTTPS URL",
  );
const pub = (u) => ({
  _id: u._id,
  name: u.name,
  email: u.email,
  phone: u.phone,
  role: u.role,
  referralCode: u.referralCode,
  depositBalance: u.depositBalance,
  withdrawableBalance: u.withdrawableBalance,
  mustChangePassword: u.mustChangePassword,
  blocked: u.blocked,
  avatar: u.avatar ? `/api/me/avatar?v=${u.avatar}` : null,
  createdAt: u.createdAt,
});
const sign = (u, actor) =>
  jwt.sign(
    {
      ver: u.tokenVersion,
      ...(actor
        ? { actor: String(actor._id), actorVer: actor.tokenVersion }
        : {}),
    },
    config.secret,
    {
      subject: String(u._id),
      expiresIn: actor ? "1h" : "12h",
      issuer: "stockxearn",
      audience: "stockxearn-web",
      algorithm: "HS256",
    },
  );
const key = (req) =>
  z.string().min(16).max(100).parse(req.headers["idempotency-key"]);
const authLimit = rateLimit({
  windowMs: 900000,
  limit: 60,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
const auth = wrap(async (req, res, next) => {
  let claims;
  try {
    ensure(
      req.headers.authorization?.startsWith("Bearer "),
      "Please sign in",
      401,
    );
    claims = jwt.verify(req.headers.authorization.slice(7), config.secret, {
      algorithms: ["HS256"],
      issuer: "stockxearn",
      audience: "stockxearn-web",
    });
  } catch {
    ensure(false, "Session expired. Please sign in", 401);
  }
  const u = await User.findById(claims.sub);
  ensure(
    u && !u.blocked && u.tokenVersion === claims.ver,
    "Session expired or account unavailable",
    401,
  );
  req.user = u;
  if (claims.actor) {
    const actor = await User.findById(claims.actor);
    ensure(
      actor &&
        actor.role === "admin" &&
        !actor.blocked &&
        actor.tokenVersion === claims.actorVer,
      "Admin session expired",
      401,
    );
    req.actor = actor;
  }
  if (
    u.mustChangePassword &&
    !["/api/me", "/api/me/password", "/api/auth/logout"].includes(
      req.originalUrl.split("?")[0],
    )
  )
    ensure(false, "Change your temporary password before continuing", 403);
  if (req.method !== "GET" && (req.actor || u.role === "admin")) {
    const safe = {};
    for (const k of [
      "amount",
      "wallet",
      "direction",
      "note",
      "reason",
      "phone",
      "blocked",
      "action",
      "status",
      "name",
      "planId",
    ])
      if (req.body?.[k] !== undefined) safe[k] = req.body[k];
    await Audit.create({
      actor: req.actor ? req.actor._id : u._id,
      target: req.actor
        ? u._id
        : req.params.id && mongoose.isValidObjectId(req.params.id)
          ? req.params.id
          : undefined,
      action: `${req.method} ${req.path}`,
      details: { ...safe, impersonated: !!req.actor },
    });
  }
  next();
});
const admin = (req, res, next) =>
  req.user.role === "admin" && !req.actor
    ? next()
    : res.status(403).json({ message: "Administrator access required" });
async function paged(model, filter, req, res, populate, select, countStatuses) {
  const page = z.coerce
    .number()
    .int()
    .min(1)
    .max(100000)
    .parse(req.query.page || 1);
  let q = model
    .find(filter)
    .sort({ createdAt: -1 })
    .skip((page - 1) * 20)
    .limit(20);
  if (populate === "code") q = q.populate("code", "code");
  else if (populate) q = q.populate(populate, "name phone email");
  if (select) q = q.select(select);
  const countPromises = countStatuses
    ? countStatuses.map((status) => model.countDocuments({ status }))
    : [];
  const [items, total, ...statusCounts] = await Promise.all([
    q,
    model.countDocuments(filter),
    ...countPromises,
  ]);
  const counts = countStatuses
    ? Object.fromEntries(
        countStatuses.map((status, index) => [status, statusCounts[index]]),
      )
    : undefined;
  res.json({
    items,
    total,
    page,
    pages: Math.max(1, Math.ceil(total / 20)),
    ...(counts ? { counts } : {}),
  });
}
const sum = async (model, match, field = "amount") =>
  (
    await model.aggregate([
      { $match: match },
      { $group: { _id: null, total: { $sum: `$${field}` } } },
    ])
  )[0]?.total || 0;
const earningKinds = [
  "earning",
  "commission",
  "rank_reward",
  "code_reward",
  "community_reward",
];
app.get("/api/health", (req, res) =>
  res.status(mongoose.connection.readyState === 1 ? 200 : 503).json({
    status: mongoose.connection.readyState === 1 ? "ok" : "unavailable",
  }),
);
app.get(
  "/api/public/settings",
  wrap(async (req, res) => {
    const s = await Setting.findOne({ key: "payment" });
    res.json({ supportPhone: s.supportPhone, channelLink: s.channelLink });
  }),
);
app.get(
  "/api/public/content",
  wrap(async (req, res) => {
    const c = await Content.findOne({ key: "site" }).lean();
    res.json({ heroTitle: c.heroTitle, heroSubtitle: c.heroSubtitle });
  }),
);
app.post(
  "/api/auth/register",
  authLimit,
  wrap(async (req, res) => {
    const d = z
      .object({
        name: txt,
        phone,
        password: pwd,
        confirmPassword: pwd,
        referralCode: z.string().trim().toUpperCase().min(1).max(24),
        terms: z.literal(true),
      })
      .refine((v) => v.password === v.confirmPassword, "Passwords do not match")
      .parse(req.body);
    const parent = await User.findOne({
      referralCode: d.referralCode,
      blocked: false,
    });
    ensure(parent, "A valid referral code is required");
    const u = await User.create({
      name: d.name,
      phone: d.phone,
      password: await bcrypt.hash(d.password, 12),
      referralCode: randomBytes(6).toString("hex").toUpperCase(),
      referredBy: parent._id,
      termsAcceptedAt: new Date(),
    });
    res.status(201).json({ token: sign(u), user: pub(u) });
  }),
);
app.post(
  "/api/auth/login",
  authLimit,
  wrap(async (req, res) => {
    const d = z
      .object({
        phone: phone.optional(),
        email: email.optional(),
        password: z.string().min(1).max(128),
        admin: z.boolean().default(false),
      })
      .parse(req.body);
    ensure(d.admin ? d.email : d.phone, "Enter your login details");
    const u = await User.findOne(
      d.admin
        ? { email: d.email, role: "admin" }
        : { phone: d.phone, role: "member" },
    ).select("+password");
    const valid = await bcrypt.compare(
      d.password,
      u?.password ||
        "$2b$12$C6UzMDM.H6dfI/f/IKcEe.7F2FG4.5FfWi8JpMhi9cM.z0t0yF/2.",
    );
    ensure(
      u && valid && !u.blocked,
      "Invalid credentials or account unavailable",
      401,
    );
    res.json({ token: sign(u), user: pub(u) });
  }),
);
app.use("/api", auth);
app.get("/api/me", (req, res) =>
  res.json({ ...pub(req.user), impersonating: !!req.actor }),
);
app.patch(
  "/api/me",
  wrap(async (req, res) => {
    const d = z.object({ name: txt }).strict().parse(req.body);
    Object.assign(req.user, d);
    await req.user.save();
    res.json(pub(req.user));
  }),
);
app.post(
  "/api/me/password",
  wrap(async (req, res) => {
    ensure(
      !req.actor,
      "Use the admin reset function to change a member password",
      403,
    );
    const d = z
      .object({ currentPassword: z.string().max(128), newPassword: pwd })
      .parse(req.body);
    const u = await User.findById(req.user._id).select("+password");
    ensure(
      await bcrypt.compare(d.currentPassword, u.password),
      "Current password is incorrect",
    );
    ensure(d.currentPassword !== d.newPassword, "Choose a different password");
    u.password = await bcrypt.hash(d.newPassword, 12);
    u.mustChangePassword = false;
    u.tokenVersion++;
    await u.save();
    res.json({ token: sign(u), user: pub(u) });
  }),
);
app.post(
  "/api/auth/logout",
  wrap(async (req, res) => {
    if (!req.actor)
      await User.updateOne(
        { _id: req.user._id },
        { $inc: { tokenVersion: 1 } },
      );
    res.json({ message: "Signed out" });
  }),
);
app.get(
  "/api/settings",
  wrap(async (req, res) => res.json(await Setting.findOne({ key: "payment" }))),
);
app.get(
  "/api/content",
  wrap(async (req, res) => res.json(await Content.findOne({ key: "site" }))),
);
app.get("/api/institutions", (req, res) => res.json(INSTITUTIONS));
app.get(
  "/api/plans",
  wrap(async (req, res) =>
    res.json(await Plan.find({ enabled: true }).sort({ price: 1 })),
  ),
);
app.get(
  "/api/plans/:id",
  wrap(async (req, res) => {
    const p = await Plan.findOne({
      _id: id.parse(req.params.id),
      enabled: true,
    });
    ensure(p, "Plan unavailable", 404);
    res.json(p);
  }),
);
app.get(
  "/api/purchases",
  wrap(async (req, res) =>
    res.json(
      await Purchase.find({ user: req.user._id }).sort({ createdAt: -1 }),
    ),
  ),
);
app.post(
  "/api/purchases",
  wrap(async (req, res) =>
    res
      .status(201)
      .json(await buyPlan(req.user._id, id.parse(req.body.planId), key(req))),
  ),
);
app.get(
  "/api/ranks",
  wrap(async (req, res) => res.json(await rankProgress(req.user._id))),
);
app.post(
  "/api/ranks/:id/claim",
  wrap(async (req, res) =>
    res.json(await claimRank(req.user._id, id.parse(req.params.id))),
  ),
);
app.post(
  "/api/reward-codes/redeem",
  wrap(async (req, res) =>
    res.json(
      await redeem(
        req.user._id,
        z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z0-9-]{3,40}$/)
          .parse(req.body.code),
      ),
    ),
  ),
);
app.get(
  "/api/reward-codes/history",
  wrap((req, res) =>
    paged(Redemption, { user: req.user._id }, req, res, "code"),
  ),
);
app.get(
  "/api/community",
  wrap(async (req, res) =>
    res.json(await Community.findOne({ user: req.user._id })),
  ),
);
app.get(
  "/api/team",
  wrap(async (req, res) => {
    const levels = await teamLevels(req.user._id);
    const s = await Setting.findOne({ key: "payment" });
    res.json({
      referralCode: req.user.referralCode,
      levels: levels.map((l, i) => ({ ...l, rate: s.commissions[i] })),
      totalCommissions: await sum(Transaction, {
        user: req.user._id,
        kind: "commission",
      }),
    });
  }),
);
app.get(
  "/api/overview",
  wrap(async (req, res) => {
    const user = req.user._id;
    const [
      activePlans,
      totalEarnings,
      totalCommissions,
      invested,
      recent,
      ranks,
      byKind,
      chart,
    ] = await Promise.all([
      Purchase.countDocuments({
        user,
        status: "active",
        endsAt: { $gt: new Date() },
      }),
      sum(Transaction, { user, kind: { $in: earningKinds } }),
      sum(Transaction, { user, kind: "commission" }),
      sum(Purchase, { user }, "price"),
      Transaction.find({ user }).sort({ createdAt: -1 }).limit(6),
      rankProgress(user),
      Transaction.aggregate([
        { $match: { user, kind: { $in: earningKinds } } },
        { $group: { _id: "$kind", total: { $sum: "$amount" } } },
      ]),
      Transaction.aggregate([
        {
          $match: {
            user,
            kind: { $in: earningKinds },
            createdAt: { $gte: new Date(Date.now() - 30 * 86400000) },
          },
        },
        {
          $group: {
            _id: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$createdAt",
                timezone: "Asia/Karachi",
              },
            },
            total: { $sum: "$amount" },
          },
        },
        { $sort: { _id: 1 } },
      ]),
    ]);
    res.json({
      user: pub(req.user),
      activePlans,
      totalEarnings,
      totalCommissions,
      invested,
      recent,
      ranks,
      byKind,
      chart,
    });
  }),
);
for (const [route, model] of [
  ["transactions", Transaction],
  ["earnings", Transaction],
  ["deposits", Deposit],
  ["withdrawals", Withdrawal],
])
  app.get(
    `/api/${route}`,
    wrap(async (req, res) => {
      const filter = { user: req.user._id };
      if (route === "earnings") filter.kind = { $in: earningKinds };
      if (req.query.kind)
        filter.kind = z
          .enum([
            ...earningKinds,
            "deposit",
            "purchase",
            "withdrawal",
            "refund",
            "adjustment",
          ])
          .parse(req.query.kind);
      if (req.query.status)
        filter.status = z
          .enum(["pending", "approved", "rejected", "paid"])
          .parse(req.query.status);
      await paged(model, filter, req, res);
    }),
  );
const uploadDir = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : fileURLToPath(new URL("../uploads/", import.meta.url));
await mkdir(uploadDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => cb(null, randomBytes(24).toString("hex")),
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 6 },
  fileFilter: (req, f, cb) =>
    cb(null, ["image/png", "image/jpeg", "image/webp"].includes(f.mimetype)),
});
async function validateImage(file) {
  ensure(file, "Upload a PNG, JPEG or WebP image up to 5 MB");
  const b = await readFile(file.path);
  const ok =
    file.mimetype === "image/png"
      ? b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : file.mimetype === "image/jpeg"
        ? b[0] === 255 && b[1] === 216 && b[2] === 255
        : b.subarray(0, 4).toString() === "RIFF" &&
          b.subarray(8, 12).toString() === "WEBP";
  ensure(ok, "Image contents do not match the file type");
}
function uploaded(fn) {
  return wrap(async (req, res) => {
    try {
      await validateImage(req.file);
      await fn(req, res);
    } catch (e) {
      if (req.file) await unlink(req.file.path).catch(() => {});
      throw e;
    }
  });
}
app.post(
  "/api/me/avatar",
  upload.single("avatar"),
  uploaded(async (req, res) => {
    const previous = req.user.avatar;
    req.user.avatar = req.file.filename;
    req.user.avatarMime = req.file.mimetype;
    await req.user.save();
    if (previous) await unlink(path.join(uploadDir, previous)).catch(() => {});
    res.json(pub(req.user));
  }),
);
app.get(
  "/api/me/avatar",
  wrap(async (req, res) => {
    ensure(req.user.avatar, "Avatar not found", 404);
    res
      .set("Cache-Control", "no-store")
      .type(req.user.avatarMime)
      .sendFile(path.join(uploadDir, req.user.avatar));
  }),
);
app.post(
  "/api/deposits",
  upload.single("screenshot"),
  uploaded(async (req, res) => {
    const d = z
      .object({
        amount: z.coerce
          .number()
          .pipe(cash.refine((n) => n >= 300, "Minimum deposit is $3")),
        method: z.enum(["easypaisa", "jazzcash"]),
        tid: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z0-9-]{5,80}$/, "Enter a valid transaction ID"),
      })
      .parse(req.body);
    res.status(201).json(
      await Deposit.create({
        user: req.user._id,
        ...d,
        // Deposit records retain the amount transferred in PKR; wallet credit
        // and all user-facing entry amounts are USD cents.
        amount: d.amount * 280,
        creditedAmount: d.amount,
        screenshot: req.file.filename,
        mime: req.file.mimetype,
      }),
    );
  }),
);
app.post(
  "/api/community",
  upload.single("screenshot"),
  uploaded(async (req, res) =>
    res.status(201).json(
      await Community.create({
        user: req.user._id,
        screenshot: req.file.filename,
        mime: req.file.mimetype,
      }),
    ),
  ),
);
for (const [route, model] of [
  ["deposits", Deposit],
  ["community", Community],
])
  app.get(
    `/api/${route}/:id/proof`,
    wrap(async (req, res) => {
      const d = await model.findById(id.parse(req.params.id));
      ensure(
        d &&
          (req.user.role === "admin" ||
            String(d.user) === String(req.user._id)),
        "Proof not found",
        404,
      );
      res
        .set("Cache-Control", "no-store")
        .type(d.mime)
        .sendFile(path.join(uploadDir, d.screenshot));
    }),
  );
app.post(
  "/api/withdrawals",
  wrap(async (req, res) => {
    const d = z
      .object({
        amount: cash.refine(
          (n) => n >= 100,
          "Minimum withdrawal is $1",
        ),
        institution: z.enum(INSTITUTIONS.map((i) => i.id)),
        customInstitution: z.string().trim().max(160).default(""),
        accountName: txt,
        accountNumber: z
          .string()
          .trim()
          .regex(
            /^[A-Za-z0-9 -]{6,40}$/,
            "Enter a valid account number or IBAN",
          ),
      })
      .parse(req.body);
    ensure(
      d.institution !== "other" || d.customInstitution.length >= 3,
      "Enter your bank or wallet name",
    );
    res.status(201).json(await requestWithdrawal(req.user._id, d, key(req)));
  }),
);
app.get(
  "/api/notifications",
  wrap(async (req, res) => {
    const items = await Notification.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .limit(100);
    res.json({
      items,
      unread: await Notification.countDocuments({
        user: req.user._id,
        ...(req.user.notificationsReadAt
          ? { createdAt: { $gt: req.user.notificationsReadAt } }
          : {}),
      }),
    });
  }),
);
app.post(
  "/api/notifications/read",
  wrap(async (req, res) => {
    req.user.notificationsReadAt = new Date();
    await req.user.save();
    res.json({ message: "Notifications marked as read" });
  }),
);
app.get(
  "/api/tickets",
  wrap((req, res) =>
    paged(Ticket, { user: req.user._id }, req, res, null, "-messages"),
  ),
);
app.post(
  "/api/tickets",
  wrap(async (req, res) => {
    const d = z
      .object({
        subject: txt,
        category: z.enum(["account", "deposit", "withdrawal", "plan", "other"]),
        message: z.string().trim().min(5).max(4000),
      })
      .parse(req.body);
    res.status(201).json(
      await Ticket.create({
        user: req.user._id,
        subject: d.subject,
        category: d.category,
        messages: [{ author: req.user._id, role: "member", body: d.message }],
      }),
    );
  }),
);
app.get(
  "/api/tickets/:id",
  wrap(async (req, res) => {
    const t = await Ticket.findOne({
      _id: id.parse(req.params.id),
      user: req.user._id,
    });
    ensure(t, "Ticket not found", 404);
    res.json(t);
  }),
);
async function reply(req, res, isAdmin) {
  const message = z.string().trim().min(1).max(4000).parse(req.body.message);
  const t = await Ticket.findOneAndUpdate(
    {
      _id: id.parse(req.params.id),
      ...(!isAdmin ? { user: req.user._id } : {}),
      status: "open",
    },
    {
      $push: {
        messages: {
          author: req.actor ? req.actor._id : req.user._id,
          role: isAdmin ? "admin" : "member",
          body: message,
          createdAt: new Date(),
        },
      },
    },
    { new: true, runValidators: true },
  );
  ensure(t, "Ticket closed or unavailable", 409);
  if (isAdmin)
    await Notification.create({
      user: t.user,
      title: "Support replied",
      body: t.subject,
      link: `/app/support/${t._id}`,
    });
  res.json(t);
}
app.post(
  "/api/tickets/:id/replies",
  wrap((req, res) => reply(req, res, false)),
);
app.use("/api/admin", admin);
app.get(
  "/api/admin/overview",
  wrap(async (req, res) => {
    const [
      users,
      activePlans,
      pendingDeposits,
      pendingWithdrawals,
      pendingCommunity,
      deposits,
      withdrawals,
      earnings,
      commissions,
      rewards,
      investment,
      balances,
      chart,
      recent,
    ] = await Promise.all([
      User.countDocuments({ role: "member" }),
      Purchase.countDocuments({
        status: "active",
        endsAt: { $gt: new Date() },
      }),
      Deposit.countDocuments({ status: "pending" }),
      Withdrawal.countDocuments({ status: "pending" }),
      Community.countDocuments({ status: "pending" }),
      sum(Deposit, { status: "approved" }, "creditedAmount"),
      sum(Withdrawal, { status: "paid" }),
      sum(Transaction, { kind: "earning" }),
      sum(Transaction, { kind: "commission" }),
      sum(Transaction, {
        kind: { $in: ["rank_reward", "code_reward", "community_reward"] },
      }),
      sum(Purchase, {}, "price"),
      User.aggregate([
        {
          $group: {
            _id: null,
            deposits: { $sum: "$depositBalance" },
            withdrawable: { $sum: "$withdrawableBalance" },
          },
        },
      ]),
      Transaction.aggregate([
        {
          $match: {
            kind: { $in: ["deposit", "withdrawal", "refund"] },
            createdAt: { $gte: new Date(Date.now() - 30 * 86400000) },
          },
        },
        {
          $group: {
            _id: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$createdAt",
                timezone: "Asia/Karachi",
              },
            },
            deposits: {
              $sum: { $cond: [{ $eq: ["$kind", "deposit"] }, "$amount", 0] },
            },
            withdrawals: {
              $sum: {
                $switch: {
                  branches: [
                    { case: { $eq: ["$kind", "withdrawal"] }, then: "$amount" },
                    {
                      case: { $eq: ["$kind", "refund"] },
                      then: { $multiply: ["$amount", -1] },
                    },
                  ],
                  default: 0,
                },
              },
            },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      Transaction.find()
        .sort({ createdAt: -1 })
        .limit(8)
        .populate("user", "name phone"),
    ]);
    res.json({
      users,
      activePlans,
      pendingDeposits,
      pendingWithdrawals,
      pendingCommunity,
      deposits,
      withdrawals,
      earnings,
      commissions,
      rewards,
      investment,
      balances: balances[0] || { deposits: 0, withdrawable: 0 },
      chart,
      recent,
      referralCode: req.user.referralCode,
    });
  }),
);
app.get(
  "/api/admin/users",
  wrap(async (req, res) => {
    const q = z
      .string()
      .max(160)
      .parse(req.query.q || "")
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const filter = {
      role: "member",
      ...(q
        ? {
            $or: [
              { name: { $regex: q, $options: "i" } },
              { phone: { $regex: q } },
            ],
          }
        : {}),
    };
    await paged(User, filter, req, res, null, "-tokenVersion");
  }),
);
app.get(
  "/api/admin/users/:id/detail",
  wrap(async (req, res) => {
    const user = await User.findOne({
      _id: id.parse(req.params.id),
      role: "member",
    }).populate("referredBy", "name referralCode");
    ensure(user, "User not found", 404);
    res.json({
      user: pub(user),
      inviter: user.referredBy,
      plans: await Purchase.find({ user: user._id }).sort({ createdAt: -1 }),
      transactions: await Transaction.find({ user: user._id })
        .sort({ createdAt: -1 })
        .limit(30),
    });
  }),
);
app.patch(
  "/api/admin/users/:id",
  wrap(async (req, res) => {
    const d = z
      .object({
        blocked: z.boolean().optional(),
        phone: phone.optional(),
        name: txt.optional(),
      })
      .strict()
      .parse(req.body);
    ensure(Object.keys(d).length, "No changes supplied");
    const u = await User.findOneAndUpdate(
      { _id: id.parse(req.params.id), role: "member" },
      { $set: d, $inc: { tokenVersion: 1 } },
      { new: true, runValidators: true },
    );
    ensure(u, "User not found", 404);
    res.json(pub(u));
  }),
);
app.post(
  "/api/admin/users/:id/login",
  wrap(async (req, res) => {
    const u = await User.findOne({
      _id: id.parse(req.params.id),
      role: "member",
      blocked: false,
    });
    ensure(u, "Active user not found", 404);
    res.json({ token: sign(u, req.user), user: pub(u) });
  }),
);
app.post(
  "/api/admin/users/:id/reset-password",
  wrap(async (req, res) => {
    const password = `Sx!${randomBytes(15).toString("base64url")}9a`;
    const u = await User.findOneAndUpdate(
      { _id: id.parse(req.params.id), role: "member" },
      {
        $set: {
          password: await bcrypt.hash(password, 12),
          mustChangePassword: true,
        },
        $inc: { tokenVersion: 1 },
      },
    );
    ensure(u, "User not found", 404);
    res.json({
      temporaryPassword: password,
      message:
        "Share privately after verifying account ownership. A password change is required at next login.",
    });
  }),
);
app.post(
  "/api/admin/users/:id/balance",
  wrap(async (req, res) => {
    const d = z
      .object({
        wallet: z.enum(["deposit", "withdrawable"]),
        direction: z.enum(["add", "remove"]),
        amount: cash,
        reason: z.string().trim().min(5).max(500),
      })
      .parse(req.body);
    const user = id.parse(req.params.id);
    res.json(
      await atomic(async (session) => {
        const field =
          d.wallet === "deposit" ? "depositBalance" : "withdrawableBalance";
        const u = await User.findOneAndUpdate(
          {
            _id: user,
            role: "member",
            ...(d.direction === "remove"
              ? { [field]: { $gte: d.amount } }
              : {}),
          },
          { $inc: { [field]: d.direction === "add" ? d.amount : -d.amount } },
          { new: true, session },
        );
        ensure(u, "User not found or insufficient balance");
        await ledger(
          session,
          u._id,
          "adjustment",
          d.amount,
          d.direction === "add" ? "in" : "out",
          d.wallet,
          randomUUID(),
          `Admin adjustment: ${d.reason}`,
        );
        return pub(u);
      }),
    );
  }),
);
app.get(
  "/api/admin/plans",
  wrap(async (req, res) => res.json(await Plan.find().sort({ price: 1 }))),
);
const planSchema = z
  .object({
    name: txt,
    description: z.string().max(1000),
    image: z.string().regex(/^\/images\/[a-z0-9.-]+$/),
    price: cash,
    daily: cash,
    duration: z.number().int().min(1).max(3650),
    enabled: z.boolean(),
    locked: z.boolean(),
  })
  .refine(
    (v) => Number.isSafeInteger(v.daily * v.duration),
    "Total payout is too large",
  )
  .transform((v) => ({ ...v, total: v.daily * v.duration }));
app.patch(
  "/api/admin/plans/:id",
  wrap(async (req, res) => {
    const d = planSchema.parse(req.body),
      p = await Plan.findByIdAndUpdate(
        id.parse(req.params.id),
        { $set: d },
        { new: true, runValidators: true },
      );
    ensure(p, "Plan not found", 404);
    res.json(p);
  }),
);
app.get(
  "/api/admin/ranks",
  wrap(async (req, res) => res.json(await Rank.find().sort({ level: 1 }))),
);
app.patch(
  "/api/admin/ranks/:id",
  wrap(async (req, res) => {
    const d = z
      .object({ name: txt, personal: cash, team: cash, reward: cash })
      .parse(req.body);
    const r = await Rank.findByIdAndUpdate(
      id.parse(req.params.id),
      { $set: d },
      { new: true, runValidators: true },
    );
    ensure(r, "Rank not found", 404);
    res.json(r);
  }),
);
for (const [route, model, review, actions] of [
  ["deposits", Deposit, reviewDeposit, ["approved", "rejected"]],
  ["withdrawals", Withdrawal, reviewWithdrawal, ["paid", "rejected"]],
  ["community", Community, reviewCommunity, ["approved", "rejected"]],
]) {
  app.get(
    `/api/admin/${route}`,
    wrap((req, res) => {
      const status = req.query.status
        ? z.enum(["pending", ...actions]).parse(req.query.status)
        : null;
      return paged(
        model,
        status ? { status } : {},
        req,
        res,
        "user",
        undefined,
        ["pending", ...actions],
      );
    }),
  );
  app.post(
    `/api/admin/${route}/:id/review`,
    wrap(async (req, res) => {
      const d = z
        .object({
          action: z.enum(actions),
          note: z.string().trim().max(500).default(""),
        })
        .parse(req.body);
      ensure(
        d.action !== "rejected" || d.note.length >= 3,
        "A rejection reason is required",
      );
      res.json(
        await review(id.parse(req.params.id), req.user._id, d.action, d.note),
      );
    }),
  );
}
app.get(
  "/api/admin/transactions",
  wrap((req, res) => {
    const filter = {};
    if (req.query.kind)
      filter.kind = z
        .enum([
          ...earningKinds,
          "deposit",
          "purchase",
          "withdrawal",
          "refund",
          "adjustment",
        ])
        .parse(req.query.kind);
    return paged(Transaction, filter, req, res, "user");
  }),
);
app.get(
  "/api/admin/commissions",
  wrap(async (req, res) =>
    res.json({
      settings: await Setting.findOne({ key: "payment" }),
      totals: await Transaction.aggregate([
        { $match: { kind: "commission" } },
        {
          $group: {
            _id: { $arrayElemAt: [{ $split: ["$reference", ":"] }, 1] },
            total: { $sum: "$amount" },
            count: { $sum: 1 },
          },
        },
      ]),
    }),
  ),
);
app.get(
  "/api/admin/settings",
  wrap(async (req, res) => res.json(await Setting.findOne({ key: "payment" }))),
);
app.patch(
  "/api/admin/settings",
  wrap(async (req, res) => {
    const d = z
      .object({
        accountName: txt,
        accountNumber: phone,
        jazzcashName: txt,
        jazzcashNumber: phone,
        supportPhone: phone.transform((v) => "+92" + v.slice(1)),
        channelLink: z
          .string()
          .url()
          .regex(/^https:\/\/(www\.)?whatsapp\.com\/channel\//),
        commissions: z.array(z.number().min(0).max(100)).length(3),
      })
      .refine(
        (v) => v.commissions.reduce((a, b) => a + b, 0) <= 100,
        "Combined commissions cannot exceed 100%",
      )
      .parse(req.body);
    res.json(
      await Setting.findOneAndUpdate(
        { key: "payment" },
        { $set: d },
        { new: true, runValidators: true },
      ),
    );
  }),
);
app.get(
  "/api/admin/reward-codes",
  wrap((req, res) => paged(RewardCode, {}, req, res)),
);
app.post(
  "/api/admin/reward-codes",
  wrap(async (req, res) => {
    const d = z
      .object({
        code: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z0-9-]{3,40}$/),
        amount: cash,
        expiresAt: z.coerce
          .date()
          .refine((v) => v > new Date(), "Expiry must be in the future"),
        limit: z.number().int().min(1).max(1000000),
      })
      .parse(req.body);
    res.status(201).json(await RewardCode.create(d));
  }),
);
app.patch(
  "/api/admin/reward-codes/:id",
  wrap(async (req, res) => {
    const enabled = z.boolean().parse(req.body.enabled);
    const r = await RewardCode.findByIdAndUpdate(
      id.parse(req.params.id),
      { $set: { enabled } },
      { new: true },
    );
    ensure(r, "Code not found", 404);
    res.json(r);
  }),
);
app.get(
  "/api/admin/content",
  wrap(async (req, res) => res.json(await Content.findOne({ key: "site" }))),
);
app.patch(
  "/api/admin/content",
  wrap(async (req, res) => {
    const d = z
      .object({
        heroTitle: txt,
        heroSubtitle: z.string().min(1).max(2000),
        announcementEnabled: z.boolean(),
        announcementTitle: z.string().max(160),
        announcementBody: z.string().max(2000),
        announcementLink: link,
        announcementImage: link,
        popupEnabled: z.boolean(),
        popupTitle: txt,
        popupBody: z.string().max(2000),
        popupImage: link,
        popupButton: z.string().max(80),
        popupLink: link,
        faqs: z
          .array(
            z.object({ question: txt, answer: z.string().min(1).max(4000) }),
          )
          .max(30),
      })
      .parse(req.body);
    ensure(
      !d.announcementEnabled || (d.announcementTitle && d.announcementBody),
      "Announcement title and body required",
    );
    const old = await Content.findOne({ key: "site" });
    const changed = [
      "popupEnabled",
      "popupTitle",
      "popupBody",
      "popupImage",
      "popupButton",
      "popupLink",
    ].some((k) => d[k] !== old[k]);
    res.json(
      await Content.findOneAndUpdate(
        { key: "site" },
        { $set: d, ...(changed ? { $inc: { popupVersion: 1 } } : {}) },
        { new: true, runValidators: true },
      ),
    );
  }),
);
app.post(
  "/api/admin/media",
  upload.single("image"),
  uploaded(async (req, res) => {
    await Media.create({ file: req.file.filename, mime: req.file.mimetype });
    res.status(201).json({ url: `/api/media/${req.file.filename}` });
  }),
);
app.get(
  "/api/media/:file",
  wrap(async (req, res) => {
    const file = z
      .string()
      .regex(/^[a-f0-9]{48}$/)
      .parse(req.params.file);
    const media = await Media.findOne({ file });
    ensure(media, "Media not found", 404);
    res
      .set("Cache-Control", "private, max-age=3600")
      .type(media.mime)
      .sendFile(path.join(uploadDir, file));
  }),
);
app.get(
  "/api/admin/reports",
  wrap(async (req, res) => {
    const flow = await Transaction.aggregate([
      {
        $group: {
          _id: { kind: "$kind", direction: "$direction", wallet: "$wallet" },
          amount: { $sum: "$amount" },
          count: { $sum: 1 },
        },
      },
    ]);
    const purchases = await Purchase.aggregate([
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
          purchased: { $sum: "$price" },
          paid: { $sum: "$paid" },
          remaining: { $sum: { $subtract: ["$total", "$paid"] } },
        },
      },
    ]);
    res.json({ flow, purchases });
  }),
);
app.get(
  "/api/admin/tickets",
  wrap((req, res) =>
    paged(
      Ticket,
      req.query.status
        ? { status: z.enum(["open", "closed"]).parse(req.query.status) }
        : {},
      req,
      res,
      "user",
      "-messages",
    ),
  ),
);
app.get(
  "/api/admin/tickets/:id",
  wrap(async (req, res) => {
    const t = await Ticket.findById(id.parse(req.params.id)).populate(
      "user",
      "name phone",
    );
    ensure(t, "Ticket not found", 404);
    res.json(t);
  }),
);
app.post(
  "/api/admin/tickets/:id/replies",
  wrap((req, res) => reply(req, res, true)),
);
app.patch(
  "/api/admin/tickets/:id",
  wrap(async (req, res) => {
    const status = z.enum(["open", "closed"]).parse(req.body.status);
    const t = await Ticket.findByIdAndUpdate(
      id.parse(req.params.id),
      { $set: { status } },
      { new: true },
    );
    ensure(t, "Ticket not found", 404);
    res.json(t);
  }),
);
app.use("/api", (req, res) =>
  res.status(404).json({ message: "API route not found" }),
);
const dist = fileURLToPath(new URL("../../frontend/dist/", import.meta.url));
app.use(express.static(dist));
app.get("/{*path}", (req, res, next) =>
  res.sendFile(path.join(dist, "index.html"), (e) => e && next(e)),
);
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status =
    err instanceof z.ZodError
      ? 400
      : err.code === 11000
        ? 409
        : err instanceof multer.MulterError
          ? 400
          : err.status || 500;
  const message =
    err instanceof z.ZodError
      ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
      : err.code === 11000
        ? "Already submitted, claimed, or registered. Refresh to see the current status."
        : status === 500
          ? "Unable to complete this request"
          : err.message;
  if (status === 500) console.error(err);
  res.status(status).json({ message });
});
