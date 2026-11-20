import "dotenv/config";
export const config = {
  port: Number(process.env.PORT || 4000),
  mongo:
    process.env.MONGODB_URI ||
    "mongodb://127.0.0.1:27017/tickernest?replicaSet=rs0",
  secret: process.env.JWT_SECRET,
  origin: process.env.CLIENT_ORIGIN || "http://localhost:5173",
};
export function assertConfig() {
  if (!config.secret || config.secret.length < 48)
    throw new Error(
      "Set JWT_SECRET to a random string of at least 48 characters",
    );
}
