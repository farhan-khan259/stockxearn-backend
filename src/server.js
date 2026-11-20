import mongoose from "mongoose";
import cron from "node-cron";
import { config, assertConfig } from "./config.js";
import { initialize, runEarnings } from "./services.js";
assertConfig();
await mongoose.connect(config.mongo);
await initialize();
const { app } = await import("./app.js");
let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    await runEarnings();
  } catch (e) {
    console.error("Payout settlement failed:", e.message);
  } finally {
    busy = false;
  }
}
await tick();
const job = cron.schedule("* * * * *", tick);
const server = app.listen(config.port, "127.0.0.1", () =>
  console.log(`TickerNest listening on ${config.port}`),
);
async function shutdown() {
  job.stop();
  server.close(async () => {
    await mongoose.disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
