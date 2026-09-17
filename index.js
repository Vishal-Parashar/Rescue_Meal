const express = require("express");
require("dotenv").config();
const pool = require("./db");
const { roles, verifyPassword, hashPassword, createToken, hashToken } = require("./auth");
const dashboardFiles = {
  Admin: "admin.html",
  NGO: "ngo.html",
  FoodProducer: "food-producer.html",
  "delivery partner": "delivery-partner.html",
};

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  return next();
});

function readCookie(request, name) {
  const cookies = request.headers.cookie?.split(";") || [];
  const cookie = cookies.find((item) => item.trim().startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.trim().slice(name.length + 1)) : null;
}

async function getSession(request) {
  const token = readCookie(request, "resqmeal_session");
  if (!token) return null;
  const result = await pool.query(
    `SELECT u.id, u.email, u.display_name, u.role
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > NOW() AND u.is_active = TRUE`,
    [hashToken(token)],
  );
  return result.rows[0] || null;
}

function setSessionCookie(response, token, remember) {
  const maxAge = remember ? 60 * 60 * 24 * 30 : 60 * 60 * 8;
  response.setHeader("Set-Cookie", `resqmeal_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`);
}

async function requireAdmin(request, response) {
  const session = await getSession(request);
  if (!session) {
    response.status(401).json({ error: "Authentication required." });
    return null;
  }

  if (session.role !== "Admin") {
    response.status(403).json({ error: "Admin access required." });
    return null;
  }
  return session;
}

async function requireRole(request, response, role) {
  const session = await getSession(request);
  if (!session) {
    response.status(401).json({ error: "Authentication required." });
    return null;
  }
  if (session.role !== role) {
    response.status(403).json({ error: `${role} access required.` });
    return null;
  }
  return session;
}

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

app.use(express.static(__dirname + "/public"));

app.get("/ngo", (req, res) => {
  res.redirect("/dashboard/ngo");
});

app.post("/api/auth/login", async (req, res, next) => {
  const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = typeof req.body.password === "string" ? req.body.password : "";
  const remember = req.body.remember === true;

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  try {
    const result = await pool.query(
      "SELECT id, email, password_hash, role FROM users WHERE email = $1 AND is_active = TRUE",
      [email],
    );
    const user = result.rows[0];

    if (!user || !verifyPassword(password, user.password_hash) || !roles[user.role]) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const token = createToken();
    const hours = remember ? 24 * 30 : 8;
    await pool.query(
      "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 hour'))",
      [hashToken(token), user.id, hours],
    );
    setSessionCookie(res, token, remember);
    return res.json({ redirect: roles[user.role], role: user.role });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/auth/register", async (req, res, next) => {
  const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = typeof req.body.password === "string" ? req.body.password : "";
  const role = typeof req.body.role === "string" ? req.body.role : "";
  if (!email || !password || password.length < 6 || !roles[role]) {
    return res.status(400).json({ error: "Email, password (6+ characters), and a valid role are required." });
  }
  try {
    await pool.query("INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3)", [email, hashPassword(password), role]);
    return res.status(201).json({ message: "Account created. You can now sign in." });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "An account with that email already exists." });
    return next(error);
  }
});

app.post("/api/auth/logout", async (req, res, next) => {
  try {
    const token = readCookie(req, "resqmeal_session");
    if (token) await pool.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
    res.setHeader("Set-Cookie", "resqmeal_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    return res.json({ message: "Signed out." });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/auth/forgot-password", async (req, res, next) => {
  const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
  if (!email) return res.status(400).json({ error: "Email address is required." });
  try {
    const result = await pool.query("SELECT id FROM users WHERE email = $1 AND is_active = TRUE", [email]);
    if (result.rows[0]) {
      const token = createToken();
      await pool.query("DELETE FROM password_resets WHERE user_id = $1", [result.rows[0].id]);
      await pool.query("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 hour')", [hashToken(token), result.rows[0].id]);
      console.log(`Password reset token for ${email}: ${token}`);
    }
    return res.json({ message: "If that email exists, reset instructions have been created." });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/auth/reset-password", async (req, res, next) => {
  const token = typeof req.body.token === "string" ? req.body.token : "";
  const password = typeof req.body.password === "string" ? req.body.password : "";
  if (!token || password.length < 6) return res.status(400).json({ error: "A valid token and 6+ character password are required." });
  try {
    const result = await pool.query("SELECT user_id FROM password_resets WHERE token_hash = $1 AND expires_at > NOW() AND used_at IS NULL", [hashToken(token)]);
    if (!result.rows[0]) return res.status(400).json({ error: "Reset token is invalid or expired." });
    await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [hashPassword(password), result.rows[0].user_id]);
    await pool.query("UPDATE password_resets SET used_at = NOW() WHERE token_hash = $1", [hashToken(token)]);
    return res.json({ message: "Password updated. You can now sign in." });
  } catch (error) {
    return next(error);
  }
});

app.get("/api/profile", async (req, res, next) => {
  try {
    const session = await getSession(req);
    if (!session) return res.status(401).json({ error: "Authentication required." });
    return res.json(session);
  } catch (error) {
    return next(error);
  }
});

app.patch("/api/profile", async (req, res, next) => {
  const displayName = typeof req.body.displayName === "string" ? req.body.displayName.trim() : "";
  if (!displayName || displayName.length > 120) {
    return res.status(400).json({ error: "A profile name between 1 and 120 characters is required." });
  }
  try {
    const session = await getSession(req);
    if (!session) return res.status(401).json({ error: "Authentication required." });
    if (!["NGO", "FoodProducer"].includes(session.role)) {
      return res.status(403).json({ error: "Only NGOs and Food Producers can edit organization names." });
    }
    const result = await pool.query(
      "UPDATE users SET display_name = $1 WHERE id = $2 RETURNING id, email, display_name, role",
      [displayName, session.id],
    );
    return res.json({ profile: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

app.get("/api/admin/users", async (req, res, next) => {
  try {
    if (!await requireAdmin(req, res)) return;
    const result = await pool.query(
      "SELECT id, email, display_name, role, is_active, created_at FROM users ORDER BY created_at DESC",
    );
    return res.json({ users: result.rows });
  } catch (error) {
    return next(error);
  }
});

app.patch("/api/admin/users/:id", async (req, res, next) => {
  const userId = Number(req.params.id);
  const role = typeof req.body.role === "string" ? req.body.role : "";
  const isActive = req.body.isActive;
  if (!Number.isInteger(userId) || (!roles[role] && typeof isActive !== "boolean")) {
    return res.status(400).json({ error: "Provide a valid role or active status." });
  }
  try {
    const session = await requireAdmin(req, res);
    if (!session) return;
    if (userId === Number(session.id)) return res.status(400).json({ error: "You cannot modify your own admin account here." });
    const result = await pool.query(
      `UPDATE users
       SET role = COALESCE($1, role), is_active = COALESCE($2, is_active)
       WHERE id = $3
       RETURNING id, email, role, is_active, created_at`,
      [roles[role] ? role : null, typeof isActive === "boolean" ? isActive : null, userId],
    );
    if (!result.rows[0]) return res.status(404).json({ error: "User not found." });
    return res.json({ user: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

app.delete("/api/admin/users/:id", async (req, res, next) => {
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: "Invalid user id." });
  try {
    const session = await requireAdmin(req, res);
    if (!session) return;
    if (userId === Number(session.id)) return res.status(400).json({ error: "You cannot delete your own admin account." });
    const result = await pool.query("DELETE FROM users WHERE id = $1 RETURNING id", [userId]);
    if (!result.rows[0]) return res.status(404).json({ error: "User not found." });
    return res.json({ message: "User deleted." });
  } catch (error) {
    return next(error);
  }
});

app.get("/api/admin/operations", async (req, res, next) => {
  try {
    if (!await requireAdmin(req, res)) return;
    const [batches, requirements, deliveryPartners, metrics] = await Promise.all([
      pool.query(
        `SELECT b.id, b.batch_code, b.food_description, b.food_category, b.quantity,
                b.quantity_value, b.status, b.assigned_shelter, b.assigned_ngo_id,
                b.delivery_partner_id, b.created_at, u.email AS producer_email,
                u.display_name AS producer_name, n.email AS ngo_email,
                n.display_name AS ngo_name, d.email AS delivery_partner_email
         FROM food_batches b
         JOIN users u ON u.id = b.producer_id
         LEFT JOIN users n ON n.id = b.assigned_ngo_id
         LEFT JOIN users d ON d.id = b.delivery_partner_id
         ORDER BY b.created_at DESC`,
      ),
      pool.query(
        `SELECT r.id, r.food_description, r.food_category, r.servings, r.needed_by,
                r.notes, r.ngo_id, u.email AS ngo_email, u.display_name AS ngo_name
         FROM food_requirements r JOIN users u ON u.id = r.ngo_id
         WHERE r.status = 'Open' ORDER BY r.needed_by ASC`,
      ),
      pool.query("SELECT id, email FROM users WHERE role = 'delivery partner' AND is_active = TRUE ORDER BY email"),
      pool.query(
        `SELECT
           COALESCE(SUM(quantity_value), 0) AS total_prepared,
           COUNT(*) FILTER (WHERE status = 'Awaiting Pickup') AS pending_allocations,
           COUNT(*) FILTER (WHERE status = 'Delivered') AS delivered_batches,
           COUNT(*) AS total_batches
         FROM food_batches`,
      ),
    ]);
    const metric = metrics.rows[0];
    const totalBatches = Number(metric.total_batches);
    const deliveredBatches = Number(metric.delivered_batches);
    return res.json({
      batches: batches.rows,
      requirements: requirements.rows,
      deliveryPartners: deliveryPartners.rows,
      metrics: {
        totalPrepared: Number(metric.total_prepared),
        pendingAllocations: Number(metric.pending_allocations),
        dispatchEfficiency: totalBatches ? Math.round((deliveredBatches / totalBatches) * 1000) / 10 : 0,
      },
    });
  } catch (error) {
    return next(error);
  }
});

app.patch("/api/admin/operations/:id", async (req, res, next) => {
  const batchId = Number(req.params.id);
  const requirementId = Number(req.body.requirementId);
  const deliveryPartnerId = Number(req.body.deliveryPartnerId);
  if (!Number.isInteger(batchId)) {
    return res.status(400).json({ error: "A valid batch is required." });
  }
  try {
    if (!await requireAdmin(req, res)) return;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const batch = await client.query("SELECT * FROM food_batches WHERE id = $1 FOR UPDATE", [batchId]);
      if (!batch.rows[0] || batch.rows[0].status === "Delivered") {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Batch not found or already delivered." });
      }
      const requirement = Number.isInteger(requirementId)
        ? await client.query(
          `SELECT r.*, u.email AS ngo_email, u.display_name AS ngo_name FROM food_requirements r
           JOIN users u ON u.id = r.ngo_id WHERE r.id = $1 AND r.status = 'Open'`,
          [requirementId],
        )
        : await client.query(
          `SELECT r.*, u.email AS ngo_email, u.display_name AS ngo_name FROM food_requirements r
           JOIN users u ON u.id = r.ngo_id
           WHERE r.status = 'Open' AND r.food_category = $1 AND r.servings <= $2
           ORDER BY r.needed_by ASC LIMIT 1`,
          [batch.rows[0].food_category, batch.rows[0].quantity_value],
        );
      if (!requirement.rows[0]) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "No open NGO requirement matches this surplus batch." });
      }
      const driver = Number.isInteger(deliveryPartnerId)
        ? await client.query("SELECT id FROM users WHERE id = $1 AND role = 'delivery partner' AND is_active = TRUE", [deliveryPartnerId])
        : await client.query("SELECT id FROM users WHERE role = 'delivery partner' AND is_active = TRUE ORDER BY id LIMIT 1");
      if (!driver.rows[0]) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "No active delivery partner is available." });
      }
      const deliveryOtp = String(Math.floor(1000 + Math.random() * 9000));
      const result = await client.query(
        `UPDATE food_batches
         SET assigned_ngo_id = $1, assigned_shelter = $2, delivery_partner_id = $3,
             delivery_otp = $4
         WHERE id = $5 AND status = 'Awaiting Pickup'
         RETURNING id, batch_code, assigned_ngo_id, delivery_partner_id, status`,
        [requirement.rows[0].ngo_id, requirement.rows[0].ngo_name || requirement.rows[0].ngo_email, driver.rows[0].id, deliveryOtp, batchId],
      );
      await client.query("UPDATE food_requirements SET status = 'Fulfilled' WHERE id = $1", [requirement.rows[0].id]);
      await client.query("COMMIT");
      return res.json({ batch: result.rows[0] });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    return next(error);
  }
});

app.get("/api/delivery/dashboard", async (req, res, next) => {
  try {
    const session = await requireRole(req, res, "delivery partner");
    if (!session) return;
    const result = await pool.query(
      `SELECT b.id, b.batch_code, b.food_description, b.quantity,
              b.status, b.assigned_shelter, b.created_at,
              u.email AS producer_email, u.display_name AS producer_name
       FROM food_batches b
       JOIN users u ON u.id = b.producer_id
       WHERE b.delivery_partner_id = $1 AND b.status IN ('Awaiting Pickup', 'Picked Up')
       ORDER BY b.created_at ASC`,
    );
    return res.json({ profile: session, assignments: result.rows });
  } catch (error) {
    return next(error);
  }
});

app.patch("/api/delivery/batches/:id", async (req, res, next) => {
  const batchId = Number(req.params.id);
  const otp = typeof req.body.otp === "string" ? req.body.otp.trim() : "";
  const stage = req.body.stage === "delivery" ? "delivery" : "pickup";
  if (!Number.isInteger(batchId) || !otp) {
    return res.status(400).json({ error: "A valid batch and OTP are required." });
  }
  try {
    if (!await requireRole(req, res, "delivery partner")) return;
    const result = await pool.query(
      stage === "pickup"
        ? `UPDATE food_batches SET status = 'Picked Up', pickup_verified_at = NOW()
           WHERE id = $1 AND delivery_partner_id = $2 AND status = 'Awaiting Pickup' AND release_otp = $3
           RETURNING id, batch_code, status`
        : `UPDATE food_batches SET status = 'Delivered', delivered_at = NOW()
           WHERE id = $1 AND delivery_partner_id = $2 AND status = 'Picked Up' AND delivery_otp = $3
           RETURNING id, batch_code, status`,
      [batchId, session.id, otp],
    );
    if (!result.rows[0]) {
      return res.status(400).json({ error: stage === "pickup" ? "Pickup OTP is incorrect or this assignment is not ready." : "Delivery OTP is incorrect or pickup has not been verified." });
    }
    return res.json({ batch: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

app.get("/api/food-producer/dashboard", async (req, res, next) => {
  try {
    const session = await requireRole(req, res, "FoodProducer");
    if (!session) return;
    const [batches, summary, inventory] = await Promise.all([
      pool.query(
        `SELECT id, batch_code, food_description, food_category, quantity, preparation_time,
                status, release_otp, created_at
         FROM food_batches
         WHERE producer_id = $1
         ORDER BY created_at DESC`,
        [session.id],
      ),
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE) AS today_batches,
           COALESCE(SUM(CASE WHEN status IN ('Awaiting Pickup', 'Picked Up') THEN quantity_value ELSE 0 END), 0) AS awaiting_servings,
           COALESCE(SUM(CASE WHEN status = 'Delivered' THEN quantity_value ELSE 0 END), 0) AS salvaged_meals,
           COALESCE(SUM(CASE WHEN created_at::date = CURRENT_DATE THEN quantity_value ELSE 0 END), 0) AS today_quantity
         FROM food_batches
         WHERE producer_id = $1`,
        [session.id],
      ),
      pool.query(
        `SELECT id, item_name, category, barcode, quantity, unit, expires_on, created_at
         FROM producer_inventory WHERE producer_id = $1 ORDER BY expires_on ASC, created_at DESC`,
        [session.id],
      ),
    ]);
    return res.json({ profile: session, batches: batches.rows, summary: summary.rows[0], inventory: inventory.rows });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/food-producer/batches", async (req, res, next) => {
  const description = typeof req.body.foodDescription === "string" ? req.body.foodDescription.trim() : "";
  const category = typeof req.body.foodCategory === "string" ? req.body.foodCategory.trim() : "";
  const quantity = typeof req.body.quantity === "string" ? req.body.quantity.trim() : "";
  const preparationTime = typeof req.body.preparationTime === "string" ? req.body.preparationTime.trim() : "";
  const quantityValue = Number.parseFloat(quantity.match(/[\d.]+/)?.[0] || "");
  if (!description || !category || !quantity || !preparationTime || !Number.isFinite(quantityValue) || quantityValue <= 0) {
    return res.status(400).json({ error: "Food description, category, quantity, and preparation time are required." });
  }
  try {
    const session = await requireRole(req, res, "FoodProducer");
    if (!session) return;
    const otp = String(Math.floor(1000 + Math.random() * 9000));
    const result = await pool.query(
      `INSERT INTO food_batches
       (producer_id, food_description, food_category, quantity, quantity_value, preparation_time, status, release_otp)
       VALUES ($1, $2, $3, $4, $5, $6, 'Awaiting Pickup', $7)
       RETURNING id, batch_code, food_description, food_category, quantity, preparation_time, status, release_otp, created_at`,
      [session.id, description, category, quantity, quantityValue, preparationTime, otp],
    );
    return res.status(201).json({ batch: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

app.delete("/api/food-producer/batches/:id", async (req, res, next) => {
  const batchId = Number(req.params.id);
  if (!Number.isInteger(batchId)) {
    return res.status(400).json({ error: "Invalid batch id." });
  }
  try {
    const session = await requireRole(req, res, "FoodProducer");
    if (!session) return;
    const result = await pool.query(
      `DELETE FROM food_batches
       WHERE id = $1 AND producer_id = $2 AND status = 'Awaiting Pickup'
       RETURNING id`,
      [batchId, session.id],
    );
    if (!result.rows[0]) {
      return res.status(409).json({ error: "Only batches still awaiting pickup can be deleted." });
    }
    return res.json({ message: "Food batch deleted." });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/food-producer/inventory", async (req, res, next) => {
  const itemName = typeof req.body.itemName === "string" ? req.body.itemName.trim() : "";
  const category = typeof req.body.category === "string" ? req.body.category.trim() : "";
  const barcode = typeof req.body.barcode === "string" ? req.body.barcode.trim() : "";
  const quantity = Number(req.body.quantity);
  const unit = typeof req.body.unit === "string" ? req.body.unit.trim() : "";
  const expiresOn = typeof req.body.expiresOn === "string" ? req.body.expiresOn.trim() : "";
  if (!itemName || !category || !Number.isFinite(quantity) || quantity <= 0 || !unit || !expiresOn) {
    return res.status(400).json({ error: "Item, category, quantity, unit, and expiry date are required." });
  }
  if (Number.isNaN(new Date(`${expiresOn}T00:00:00`).getTime())) {
    return res.status(400).json({ error: "Enter a valid expiry date." });
  }
  try {
    const session = await requireRole(req, res, "FoodProducer");
    if (!session) return;
    const result = await pool.query(
      `INSERT INTO producer_inventory (producer_id, item_name, category, barcode, quantity, unit, expires_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, item_name, category, barcode, quantity, unit, expires_on, created_at`,
      [session.id, itemName, category, barcode || null, quantity, unit, expiresOn],
    );
    return res.status(201).json({ item: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

app.delete("/api/food-producer/inventory/:id", async (req, res, next) => {
  const itemId = Number(req.params.id);
  if (!Number.isInteger(itemId)) return res.status(400).json({ error: "Invalid inventory item id." });
  try {
    const session = await requireRole(req, res, "FoodProducer");
    if (!session) return;
    const result = await pool.query(
      "DELETE FROM producer_inventory WHERE id = $1 AND producer_id = $2 RETURNING id",
      [itemId, session.id],
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Inventory item not found." });
    return res.json({ message: "Inventory item deleted." });
  } catch (error) {
    return next(error);
  }
});

app.get("/api/ngo/requirements", async (req, res, next) => {
  try {
    const session = await requireRole(req, res, "NGO");
    if (!session) return;
    const result = await pool.query(
      `SELECT id, food_description, food_category, servings, needed_by, notes, status, created_at
       FROM food_requirements WHERE ngo_id = $1 ORDER BY created_at DESC`,
      [session.id],
    );
    const deliveries = await pool.query(
      `SELECT b.id, b.batch_code, b.food_description, b.quantity, b.status,
              CASE WHEN b.status = 'Picked Up' THEN b.delivery_otp ELSE NULL END AS delivery_otp,
              b.assigned_shelter, b.created_at, u.email AS producer_email,
              u.display_name AS producer_name
       FROM food_batches b JOIN users u ON u.id = b.producer_id
       WHERE b.assigned_ngo_id = $1 ORDER BY b.created_at DESC`,
      [session.id],
    );
    return res.json({ profile: session, requirements: result.rows, deliveries: deliveries.rows });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/ngo/requirements", async (req, res, next) => {
  const description = typeof req.body.foodDescription === "string" ? req.body.foodDescription.trim() : "";
  const category = typeof req.body.foodCategory === "string" ? req.body.foodCategory.trim() : "";
  const servings = Number.parseInt(req.body.servings, 10);
  const neededBy = typeof req.body.neededBy === "string" ? req.body.neededBy : "";
  const notes = typeof req.body.notes === "string" ? req.body.notes.trim() : "";
  if (!description || !category || !Number.isInteger(servings) || servings <= 0 || !neededBy) {
    return res.status(400).json({ error: "Food description, category, servings, and required date are required." });
  }
  const neededDate = new Date(neededBy);
  if (Number.isNaN(neededDate.getTime())) {
    return res.status(400).json({ error: "Enter a valid required date." });
  }
  try {
    const session = await requireRole(req, res, "NGO");
    if (!session) return;
    const result = await pool.query(
      `INSERT INTO food_requirements
       (ngo_id, food_description, food_category, servings, needed_by, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, food_description, food_category, servings, needed_by, notes, status, created_at`,
      [session.id, description, category, servings, neededDate, notes || null],
    );
    return res.status(201).json({ requirement: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

for (const [role, route] of Object.entries(roles)) {
  app.get(route, (req, res, next) => {
    getSession(req).then((session) => {
      if (!session) return res.redirect("/");
      if (session.role !== role) return res.status(403).send("Forbidden");
      return res.sendFile(`${__dirname}/public/dashboards/${dashboardFiles[role]}`);
    }).catch(next);
  });
}

app.get("/health/db", async (req, res, next) => {
  try {
    const result = await pool.query("SELECT NOW() AS current_time");
    res.json({ connected: true, currentTime: result.rows[0].current_time });
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ error: "Database request failed" });
});

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
