import mongoose from "mongoose";
const { Schema, model } = mongoose;
const opts = { timestamps: true, strict: "throw" };
const money = {
  type: Number,
  min: 0,
  required: true,
  validate: Number.isSafeInteger,
};
const ref = (name, required = false) => ({
  type: Schema.Types.ObjectId,
  ref: name,
  required,
});
export const User = model(
  "User",
  new Schema(
    {
      name: { type: String, required: true },
      email: { type: String, unique: true, sparse: true },
      phone: { type: String, unique: true, sparse: true },
      password: { type: String, required: true, select: false },
      role: { type: String, enum: ["member", "admin"], default: "member" },
      referralCode: { type: String, required: true, unique: true },
      referredBy: ref("User"),
      depositBalance: { ...money, default: 0 },
      withdrawableBalance: { ...money, default: 0 },
      blocked: { type: Boolean, default: false },
      tokenVersion: { type: Number, default: 0 },
      mustChangePassword: { type: Boolean, default: false },
      termsAcceptedAt: Date,
      avatar: String,
      avatarMime: String,
      notificationsReadAt: Date,
    },
    opts,
  ),
);
export const Plan = model(
  "Plan",
  new Schema(
    {
      code: { type: String, unique: true, required: true },
      name: { type: String, required: true },
      image: String,
      description: String,
      price: money,
      daily: money,
      total: money,
      duration: { type: Number, required: true, min: 1, max: 3650 },
      enabled: { type: Boolean, default: true },
      locked: { type: Boolean, default: false },
      catalogVersion: { type: Number, default: 1 },
    },
    opts,
  ),
);
const ps = new Schema(
  {
    user: ref("User", true),
    plan: ref("Plan", true),
    name: String,
    image: String,
    price: money,
    daily: money,
    total: money,
    duration: Number,
    creditedDays: { type: Number, default: 0 },
    paid: { ...money, default: 0 },
    nextCreditAt: Date,
    endsAt: Date,
    status: { type: String, enum: ["active", "completed"], default: "active" },
    requestKey: { type: String, required: true },
  },
  opts,
);
ps.index({ user: 1, requestKey: 1 }, { unique: true });
ps.index({ status: 1, nextCreditAt: 1 });
export const Purchase = model("Purchase", ps);
const es = new Schema(
  {
    user: ref("User", true),
    purchase: ref("Purchase", true),
    day: Number,
    amount: money,
    earnedAt: Date,
  },
  opts,
);
es.index({ purchase: 1, day: 1 }, { unique: true });
export const Earning = model("Earning", es);
const ts = new Schema(
  {
    user: ref("User", true),
    kind: {
      type: String,
      enum: [
        "deposit",
        "purchase",
        "earning",
        "commission",
        "adjustment",
        "withdrawal",
        "refund",
        "rank_reward",
        "code_reward",
        "community_reward",
      ],
      required: true,
    },
    amount: money,
    direction: { type: String, enum: ["in", "out"], required: true },
    wallet: { type: String, enum: ["deposit", "withdrawable"], required: true },
    reference: { type: String, required: true },
    note: { type: String, required: true },
  },
  opts,
);
ts.index({ user: 1, kind: 1, reference: 1 }, { unique: true });
export const Transaction = model("Transaction", ts);
export const Deposit = model(
  "Deposit",
  new Schema(
    {
      user: ref("User", true),
      // The transfer amount is retained in PKR; wallets are denominated in USD.
      amount: money,
      creditedAmount: { type: Number, min: 0, default: 0 },
      method: { type: String, enum: ["easypaisa", "jazzcash"], required: true },
      tid: { type: String, required: true, unique: true },
      screenshot: { type: String, required: true },
      mime: String,
      status: {
        type: String,
        enum: ["pending", "approved", "rejected"],
        default: "pending",
      },
      reviewer: ref("User"),
      reviewedAt: Date,
      note: { type: String, default: "" },
    },
    opts,
  ),
);
const ws = new Schema(
  {
    user: ref("User", true),
    amount: money,
    institution: String,
    customInstitution: { type: String, default: "" },
    accountName: String,
    accountNumber: String,
    status: {
      type: String,
      enum: ["pending", "paid", "rejected"],
      default: "pending",
    },
    requestKey: String,
    reviewer: ref("User"),
    reviewedAt: Date,
    note: { type: String, default: "" },
  },
  opts,
);
ws.index({ user: 1, requestKey: 1 }, { unique: true });
export const Withdrawal = model("Withdrawal", ws);
export const Setting = model(
  "Setting",
  new Schema(
    {
      key: { type: String, unique: true },
      accountName: String,
      accountNumber: String,
      jazzcashName: String,
      jazzcashNumber: String,
      supportPhone: String,
      channelLink: String,
      commissions: { type: [Number], default: [8, 5, 2] },
    },
    opts,
  ),
);
export const Rank = model(
  "Rank",
  new Schema(
    {
      level: { type: Number, unique: true },
      name: String,
      icon: String,
      personal: money,
      team: money,
      reward: money,
    },
    opts,
  ),
);
const cs = new Schema(
  { user: ref("User", true), rank: ref("Rank", true), amount: money },
  opts,
);
cs.index({ user: 1, rank: 1 }, { unique: true });
export const RankClaim = model("RankClaim", cs);
export const RewardCode = model(
  "RewardCode",
  new Schema(
    {
      code: { type: String, unique: true },
      amount: money,
      expiresAt: Date,
      limit: Number,
      used: { type: Number, default: 0 },
      enabled: { type: Boolean, default: true },
    },
    opts,
  ),
);
const rs = new Schema(
  { user: ref("User", true), code: ref("RewardCode", true), amount: money },
  opts,
);
rs.index({ user: 1, code: 1 }, { unique: true });
export const Redemption = model("Redemption", rs);
export const Community = model(
  "Community",
  new Schema(
    {
      user: { ...ref("User", true), unique: true },
      screenshot: String,
      mime: String,
      status: {
        type: String,
        enum: ["pending", "approved", "rejected"],
        default: "pending",
      },
      note: String,
      reviewer: ref("User"),
      reviewedAt: Date,
    },
    opts,
  ),
);
export const Audit = model(
  "Audit",
  new Schema(
    {
      actor: ref("User", true),
      target: ref("User"),
      action: String,
      details: Schema.Types.Mixed,
    },
    opts,
  ),
);
export const Notification = model(
  "Notification",
  new Schema(
    { user: ref("User", true), title: String, body: String, link: String },
    opts,
  ),
);
export const Ticket = model(
  "Ticket",
  new Schema(
    {
      user: ref("User", true),
      subject: String,
      category: String,
      status: { type: String, enum: ["open", "closed"], default: "open" },
      messages: [
        {
          author: ref("User", true),
          role: String,
          body: String,
          createdAt: { type: Date, default: Date.now },
        },
      ],
    },
    opts,
  ),
);
export const Content = model(
  "Content",
  new Schema(
    {
      key: { type: String, unique: true },
      heroTitle: String,
      heroSubtitle: String,
      announcementEnabled: Boolean,
      announcementTitle: String,
      announcementBody: String,
      announcementLink: String,
      announcementImage: String,
      popupEnabled: Boolean,
      popupTitle: String,
      popupBody: String,
      popupImage: String,
      popupButton: String,
      popupLink: String,
      popupVersion: { type: Number, default: 1 },
      faqs: [{ question: String, answer: String, _id: false }],
    },
    opts,
  ),
);
export const Media = model(
  "Media",
  new Schema({ file: { type: String, unique: true }, mime: String }, opts),
);
export const models = [
  Media,
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
];
