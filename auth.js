const crypto = require("crypto");

const roles = {
  Admin: "/dashboard/admin",
  NGO: "/dashboard/ngo",
  FoodProducer: "/dashboard/food-producer",
  "delivery partner": "/dashboard/delivery-partner",
};

function verifyPassword(password, storedHash) {
  const [salt, expectedHash] = String(storedHash || "").split(":");

  if (!salt || !expectedHash) {
    return false;
  }

  const actualHash = crypto.scryptSync(password, salt, 64).toString("hex");
  const expectedBuffer = Buffer.from(expectedHash, "hex");
  const actualBuffer = Buffer.from(actualHash, "hex");

  return expectedBuffer.length === actualBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}

function createToken() {
  return crypto.randomBytes(32).toString("hex");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

module.exports = { roles, verifyPassword, hashPassword, createToken, hashToken };
