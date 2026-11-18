import mongoose from "mongoose";
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
  Notification,
  Content,
  models,
} from "./models.js";
import {
  PLAN_DATA,
  RANK_DATA,
  LEGACY_RANK_DATA,
  DAY,
  payoutForDay,
  pkrToUsdCents,
} from "./catalog.js";
export function ensure(ok, message, status = 400) {
  if (!ok) {
    const e = new Error(message);
    e.status = status;
    throw e;
  }
}
export const atomic = (fn) => mongoose.connection.transaction(fn);
export const defaults = {
  key: "payment",
  accountName: "Abdul Majid",
  accountNumber: "03379092183",
  jazzcashName: "Abdul Majid",
  jazzcashNumber: "03379092183",
  supportPhone: "+923379092183",
  channelLink: "https://whatsapp.com/channel/0029VbE0BreEAKWD5raKGd1H",
  commissions: [8, 5, 2],
};
export const contentDefaults = {
  key: "site",
  heroTitle: "A considered approach to your financial future.",
  heroSubtitle:
    "Meet StockXEarn. A privately operated investment platform with a clear member workspace, transparent records, and personal support.",
  announcementEnabled: false,
  announcementTitle: "",
  announcementBody: "",
  announcementLink: "",
  announcementImage: "",
  popupEnabled: true,
  popupTitle: "Welcome to StockXEarn",
  popupBody:
    "Explore your workspace, review plan terms, and contact our team whenever you need help.",
  popupImage: "",
  popupButton: "Explore plans",
  popupLink: "/app/plans",
  popupVersion: 1,
  faqs: [
    {
      question: "When do plan payouts begin?",
      answer:
        "The first payout is due 24 hours after purchase. Further payouts follow at 24-hour intervals. The default plans have 60 payouts, and the first 10 recover the initial investment.",
    },
    {
      question: "Can I withdraw unused deposits?",
      answer:
        "Deposits are reserved for purchasing plans. Only profits, commissions and rewards can be withdrawn. A currently active plan and a minimum withdrawal of $1 are required. There is no withdrawal fee.",
    },
    {
      question: "How are payments handled?",
      answer:
        "Easypaisa and JazzCash deposits are manually verified. Withdrawals are sent manually by the operator to your selected bank or wallet. Requests can be submitted 24/7; approval and payment are not instant.",
    },
    {
      question: "What are the investment risks?",
      answer:
        "StockXEarn is privately operated. The operator personally invests funds and manages listed payouts. Market losses and operator payment risk exist; a listed payout schedule does not establish a guaranteed market return.",
    },
    {
      question: "How do ranks work?",
      answer:
        "Ranks count lifetime plan purchases by you and members in your first three referral levels. Both targets must be met. Each qualifying rank can be claimed once.",
    },
    {
      question: "How do I reset my password?",
      answer:
        "Contact support on WhatsApp or through an existing support ticket. After account ownership is checked, an administrator can issue a temporary password. You must change it at your next login.",
    },
  ],
};
export async function initialize() {
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  ensure(
    hello.setName || hello.msg === "isdbgrid",
    "A MongoDB replica set is required for financial transactions",
    500,
  );
  await Promise.all(models.map((m) => m.init()));
  for (const p of PLAN_DATA) {
    await Plan.updateOne(
      { code: p.code },
      { $setOnInsert: p },
      { upsert: true },
    );
    // Apply the revised USD catalogue to legacy plan documents once. Purchases
    // retain their own immutable snapshots, so historical terms stay intact.
    await Plan.updateOne(
      {
        code: p.code,
        $or: [
          { catalogVersion: { $exists: false } },
          { catalogVersion: { $lt: 2 } },
        ],
      },
      { $set: p },
    );
  }
  for (let i = 0; i < RANK_DATA.length; i++) {
    const r = RANK_DATA[i];
    const existing = await Rank.findOne({ level: r.level });
    if (!existing) {
      await Rank.create(r);
      continue;
    }

    const [legacyName, legacyPersonal, legacyTeam, legacyReward] =
      LEGACY_RANK_DATA[i];
    const isDefault =
      existing.name === legacyName &&
      existing.personal === legacyPersonal * 100 &&
      existing.team === legacyTeam * 100 &&
      existing.reward === legacyReward * 100;
    if (isDefault) {
      await Rank.updateOne(
        { _id: existing._id },
        {
          $set: {
            name: r.name,
            personal: r.personal,
            team: r.team,
            reward: r.reward,
            icon: r.icon,
          },
        },
      );
    }
  }
  await Setting.updateOne(
    { key: "payment" },
    { $setOnInsert: defaults },
    { upsert: true },
  );
  await Content.updateOne(
    { key: "site" },
    { $setOnInsert: contentDefaults },
    { upsert: true },
  );
}
export async function notify(
  session,
  user,
  title,
  body,
  link = "/app/activity",
) {
  await Notification.create([{ user, title, body, link }], { session });
}
export async function ledger(
  session,
  user,
  kind,
  amount,
  direction,
  wallet,
  reference,
  note,
) {
  await Transaction.create(
    [
      {
        user,
        kind,
        amount,
        direction,
        wallet,
        reference: String(reference),
        note,
      },
    ],
    { session },
  );
  if (
    [
      "earning",
      "commission",
      "rank_reward",
      "code_reward",
      "community_reward",
    ].includes(kind)
  )
    await notify(
      session,
      user,
      note,
      `$${(amount / 100).toFixed(2)} credited to your earnings wallet.`,
    );
}
export async function creditDay(session, p, at) {
  const day = p.creditedDays + 1,
    amount = payoutForDay(p, day);
  await Earning.create(
    [{ user: p.user, purchase: p._id, day, amount, earnedAt: at }],
    { session },
  );
  await User.updateOne(
    { _id: p.user },
    { $inc: { withdrawableBalance: amount } },
    { session },
  );
  await ledger(
    session,
    p.user,
    "earning",
    amount,
    "in",
    "withdrawable",
    `${p._id}:${day}`,
    `${p.name} · Payout ${day}`,
  );
  p.creditedDays = day;
  p.paid += amount;
  p.status = day === p.duration ? "completed" : "active";
  p.nextCreditAt = p.status === "completed" ? null : new Date(+at + DAY);
  await p.save({ session });
}
export async function buyPlan(userId, planId, requestKey) {
  return atomic(async (session) => {
    const old = await Purchase.findOne({ user: userId, requestKey }).session(
      session,
    );
    if (old) return old;
    const plan = await Plan.findById(planId).session(session);
    ensure(plan, "Plan unavailable", 404);
    ensure(plan.enabled, "Plan unavailable", 404);
    ensure(
      !plan.locked,
      "This investment plan will be available soon.",
      409,
    );
    const u = await User.findOneAndUpdate(
      { _id: userId, blocked: false, depositBalance: { $gte: plan.price } },
      { $inc: { depositBalance: -plan.price } },
      { new: true, session },
    );
    ensure(u, "Insufficient deposit balance");
    const now = new Date();
    const [p] = await Purchase.create(
      [
        {
          user: userId,
          plan: plan._id,
          name: plan.name,
          image: plan.image,
          price: plan.price,
          daily: plan.daily,
          total: plan.total,
          duration: plan.duration,
          requestKey,
          nextCreditAt: new Date(+now + DAY),
          endsAt: new Date(+now + plan.duration * DAY),
        },
      ],
      { session },
    );
    await ledger(
      session,
      userId,
      "purchase",
      plan.price,
      "out",
      "deposit",
      p._id,
      `${p.name} purchased`,
    );
    return p;
  });
}
export async function reviewDeposit(id, admin, action, note) {
  return atomic(async (session) => {
    const d = await Deposit.findById(id).session(session);
    ensure(d, "Deposit not found", 404);
    ensure(d.status === "pending", "Already reviewed", 409);
    Object.assign(d, {
      status: action,
      reviewer: admin,
      reviewedAt: new Date(),
      note,
    });
    if (action === "approved" && !d.creditedAmount)
      d.creditedAmount = pkrToUsdCents(d.amount);
    await d.save({ session });
    if (action === "approved") {
      const creditedAmount = d.creditedAmount || pkrToUsdCents(d.amount);
      const owner = await User.findByIdAndUpdate(
        d.user,
        { $inc: { depositBalance: creditedAmount } },
        { new: true, session },
      );
      ensure(owner, "User not found", 404);
      await ledger(
        session,
        d.user,
        "deposit",
        creditedAmount,
        "in",
        "deposit",
        d._id,
        `${d.method} deposit approved`,
      );
      const settings = await Setting.findOne({ key: "payment" }).session(
        session,
      );
      let parent = owner.referredBy;
      for (const [i, percent] of settings.commissions.entries()) {
        if (!parent) break;
        const u = await User.findById(parent).session(session);
        if (!u) break;
        const commission = Math.floor((creditedAmount * percent) / 100);
        if (commission) {
          await User.updateOne(
            { _id: u._id },
            { $inc: { withdrawableBalance: commission } },
            { session },
          );
          await ledger(
            session,
            u._id,
            "commission",
            commission,
            "in",
            "withdrawable",
            `${d._id}:${i + 1}`,
            `Level ${i + 1} deposit commission (${percent}%)`,
          );
        }
        parent = u.referredBy;
      }
    }
    await notify(
      session,
      d.user,
      `Deposit ${action}`,
      note || "Your deposit has been reviewed.",
      "/app/deposits/history",
    );
    return d;
  });
}
export async function requestWithdrawal(userId, data, requestKey) {
  return atomic(async (session) => {
    const old = await Withdrawal.findOne({ user: userId, requestKey }).session(
      session,
    );
    if (old) return old;
    ensure(
      await Purchase.exists({
        user: userId,
        status: "active",
        endsAt: { $gt: new Date() },
      }).session(session),
      "An active plan is required",
    );
    const u = await User.findOneAndUpdate(
      {
        _id: userId,
        blocked: false,
        withdrawableBalance: { $gte: data.amount },
      },
      { $inc: { withdrawableBalance: -data.amount } },
      { new: true, session },
    );
    ensure(u, "Insufficient earnings balance");
    const [w] = await Withdrawal.create(
      [{ user: userId, ...data, requestKey }],
      { session },
    );
    await ledger(
      session,
      userId,
      "withdrawal",
      w.amount,
      "out",
      "withdrawable",
      w._id,
      "Withdrawal reserved for manual payment",
    );
    await notify(
      session,
      userId,
      "Withdrawal requested",
      "Your funds are reserved for manual payment.",
      "/app/withdrawals/history",
    );
    return w;
  });
}
export async function reviewWithdrawal(id, admin, action, note) {
  return atomic(async (session) => {
    const w = await Withdrawal.findById(id).session(session);
    ensure(w, "Withdrawal not found", 404);
    ensure(w.status === "pending", "Already reviewed", 409);
    Object.assign(w, {
      status: action,
      reviewer: admin,
      reviewedAt: new Date(),
      note,
    });
    await w.save({ session });
    if (action === "rejected") {
      await User.updateOne(
        { _id: w.user },
        { $inc: { withdrawableBalance: w.amount } },
        { session },
      );
      await ledger(
        session,
        w.user,
        "refund",
        w.amount,
        "in",
        "withdrawable",
        w._id,
        "Rejected withdrawal refunded",
      );
    }
    await notify(
      session,
      w.user,
      `Withdrawal ${action}`,
      note || "Your withdrawal has been reviewed.",
      "/app/withdrawals/history",
    );
    return w;
  });
}
export async function runEarnings(now = new Date()) {
  for await (const item of Purchase.find({
    status: "active",
    nextCreditAt: { $lte: now },
  })
    .select("_id")
    .cursor()) {
    await atomic(async (session) => {
      const p = await Purchase.findById(item._id).session(session);
      while (p && p.status === "active" && p.nextCreditAt <= now)
        await creditDay(session, p, p.nextCreditAt);
    });
  }
}
export async function teamLevels(user, session) {
  let parents = [user];
  const levels = [];
  for (let i = 1; i <= 3; i++) {
    let q = User.find({ referredBy: { $in: parents } }).select(
      "_id name createdAt",
    );
    if (session) q = q.session(session);
    const members = await q;
    parents = members.map((u) => u._id);
    levels.push({ level: i, count: members.length, members });
  }
  return levels;
}
export async function rankProgress(user, session) {
  const levels = await teamLevels(user, session);
  const ids = levels.flatMap((l) => l.members.map((m) => m._id));
  const sum = async (users) => {
    let q = Purchase.aggregate([
      { $match: { user: { $in: users } } },
      { $group: { _id: null, total: { $sum: "$price" } } },
    ]);
    if (session) q = q.session(session);
    return (await q)[0]?.total || 0;
  };
  let rq = Rank.find().sort({ level: 1 }),
    cq = RankClaim.find({ user });
  if (session) {
    rq = rq.session(session);
    cq = cq.session(session);
  }
  // A transaction session must execute its operations sequentially.
  const [personal, team, ranks, claims] = session
    ? [await sum([user]), await sum(ids), await rq, await cq]
    : await Promise.all([sum([user]), sum(ids), rq, cq]);
  return {
    personal,
    team,
    ranks: ranks.map((r) => ({
      ...r.toObject(),
      qualified: personal >= r.personal && team >= r.team,
      claimed: claims.some((c) => String(c.rank) === String(r._id)),
    })),
  };
}
export async function claimRank(user, rankId) {
  return atomic(async (session) => {
    const progress = await rankProgress(user, session),
      r = progress.ranks.find((r) => String(r._id) === rankId);
    ensure(r, "Rank not found", 404);
    ensure(r.qualified, "Rank requirements not met");
    ensure(!r.claimed, "Rank already claimed", 409);
    await RankClaim.create([{ user, rank: r._id, amount: r.reward }], {
      session,
    });
    await User.updateOne(
      { _id: user },
      { $inc: { withdrawableBalance: r.reward } },
      { session },
    );
    await ledger(
      session,
      user,
      "rank_reward",
      r.reward,
      "in",
      "withdrawable",
      r._id,
      `${r.name} milestone reward`,
    );
    return { message: "Rank reward claimed" };
  });
}
export async function redeem(user, code) {
  return atomic(async (session) => {
    const r = await RewardCode.findOneAndUpdate(
      {
        code,
        enabled: true,
        expiresAt: { $gt: new Date() },
        $expr: { $lt: ["$used", "$limit"] },
      },
      { $inc: { used: 1 } },
      { new: true, session },
    );
    ensure(r, "Code is invalid, expired, disabled, or fully claimed", 409);
    ensure(
      !(await Redemption.exists({ user, code: r._id }).session(session)),
      "You already redeemed this code",
      409,
    );
    await Redemption.create([{ user, code: r._id, amount: r.amount }], {
      session,
    });
    await User.updateOne(
      { _id: user },
      { $inc: { withdrawableBalance: r.amount } },
      { session },
    );
    await ledger(
      session,
      user,
      "code_reward",
      r.amount,
      "in",
      "withdrawable",
      r._id,
      `Reward Code ${r.code}`,
    );
    return { message: "Reward credited", amount: r.amount };
  });
}
export async function reviewCommunity(id, admin, action, note) {
  return atomic(async (session) => {
    const c = await Community.findById(id).session(session);
    ensure(c, "Submission not found", 404);
    ensure(c.status === "pending", "Already reviewed", 409);
    Object.assign(c, {
      status: action,
      note,
      reviewer: admin,
      reviewedAt: new Date(),
    });
    await c.save({ session });
    if (action === "approved") {
      await User.updateOne(
        { _id: c.user },
        { $inc: { withdrawableBalance: 1000 } },
        { session },
      );
      await ledger(
        session,
        c.user,
        "community_reward",
        1000,
        "in",
        "withdrawable",
        c._id,
        "WhatsApp community reward",
      );
    }
    await notify(
      session,
      c.user,
      `Community reward ${action}`,
      note || "Your one-time submission has been reviewed.",
      "/app/community",
    );
    return c;
  });
}
