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
const publicRegistrationRoles = new Set(["FoodProducer", "NGO", "delivery partner"]);

app.use(express.json());

async function requestPythonAi(path, body) {
  const baseUrl = String(process.env.PYTHON_AI_URL || "http://127.0.0.1:8001").replace(/\/$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return { available: false, error: payload.detail || `Python AI service returned HTTP ${response.status}.` };
    return payload;
  } catch (error) {
    return { available: false, error: error.name === "AbortError" ? "Python AI request timed out." : "Python AI service is unavailable." };
  } finally {
    clearTimeout(timeout);
  }
}

async function automaticallyAssignNgo(batch) {
  const candidates = await pool.query(
    `SELECT r.id, r.ngo_id, r.food_category, r.servings, r.needed_by,
            u.latitude AS ngo_latitude, u.longitude AS ngo_longitude,
            EXTRACT(EPOCH FROM (r.needed_by - NOW())) / 3600 AS hours_until_needed
     FROM food_requirements r
     JOIN users u ON u.id = r.ngo_id
     WHERE r.status = 'Open'
     ORDER BY r.needed_by ASC
     LIMIT 100`,
  );
  const recommendation = await requestPythonAi("/assign-ngo", {
    batch: {
      food_category: batch.food_category,
      quantity_value: batch.quantity_value,
      source_latitude: batch.source_latitude,
      source_longitude: batch.source_longitude,
    },
    requirements: candidates.rows,
  });
  if (!recommendation.available || !recommendation.assigned || !recommendation.match?.requirementId) {
    return { assigned: false, reason: recommendation.error || "No compatible NGO requirement was found." };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const requirement = await client.query(
      `SELECT r.id, r.ngo_id, u.email AS ngo_email, u.display_name AS ngo_name
       FROM food_requirements r
       JOIN users u ON u.id = r.ngo_id
       WHERE r.id = $1 AND r.status = 'Open'
       FOR UPDATE`,
      [recommendation.match.requirementId],
    );
    if (!requirement.rows[0]) {
      await client.query("ROLLBACK");
      return { assigned: false, reason: "The recommended NGO requirement was already assigned." };
    }
    const updated = await client.query(
      `UPDATE food_batches
       SET assigned_ngo_id = $1, assigned_shelter = $2,
           assignment_distance_km = $3, assignment_reason = $4
       WHERE id = $5 AND status = 'Awaiting Pickup' AND assigned_ngo_id IS NULL
       RETURNING id, batch_code, assigned_ngo_id, assigned_shelter`,
      [
        requirement.rows[0].ngo_id,
        requirement.rows[0].ngo_name || requirement.rows[0].ngo_email,
        recommendation.match.distanceKm,
        recommendation.match.reason,
        batch.id,
      ],
    );
    if (!updated.rows[0]) {
      await client.query("ROLLBACK");
      return { assigned: false, reason: "The batch is no longer awaiting pickup." };
    }
    await client.query("UPDATE food_requirements SET status = 'Fulfilled' WHERE id = $1", [requirement.rows[0].id]);
    await client.query("COMMIT");
    return {
      assigned: true,
      batch: updated.rows[0],
      distanceKm: recommendation.match.distanceKm,
      reason: recommendation.match.reason,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

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
    `SELECT u.id, u.email, u.display_name, u.location_address, u.latitude, u.longitude, u.role
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
  if (!email || !password || password.length < 6 || !publicRegistrationRoles.has(role)) {
    return res.status(400).json({ error: "Email, password (6+ characters), and one of the public registration roles is required: Food producer, NGO, or delivery partner." });
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
  const hasLocationFields = ["locationAddress", "latitude", "longitude"].some((field) => Object.prototype.hasOwnProperty.call(req.body, field));
  const locationAddress = typeof req.body.locationAddress === "string" ? req.body.locationAddress.trim() : "";
  const latitude = req.body.latitude === "" || req.body.latitude == null ? null : Number(req.body.latitude);
  const longitude = req.body.longitude === "" || req.body.longitude == null ? null : Number(req.body.longitude);
  if (!displayName || displayName.length > 120) {
    return res.status(400).json({ error: "A profile name between 1 and 120 characters is required." });
  }
  if (locationAddress.length > 240) {
    return res.status(400).json({ error: "Location address must be 240 characters or fewer." });
  }
  if ((latitude !== null && (!Number.isFinite(latitude) || latitude < -90 || latitude > 90))
    || (longitude !== null && (!Number.isFinite(longitude) || longitude < -180 || longitude > 180))
    || ((latitude === null) !== (longitude === null))) {
    return res.status(400).json({ error: "Provide both valid latitude and longitude values, or leave both blank." });
  }
  try {
    const session = await getSession(req);
    if (!session) return res.status(401).json({ error: "Authentication required." });
    const result = await pool.query(
      `UPDATE users
       SET display_name = $1,
           location_address = CASE WHEN $2 THEN $3 ELSE location_address END,
           latitude = CASE WHEN $2 THEN $4 ELSE latitude END,
           longitude = CASE WHEN $2 THEN $5 ELSE longitude END
       WHERE id = $6
       RETURNING id, email, display_name, location_address, latitude, longitude, role`,
      [displayName, hasLocationFields, locationAddress || null, latitude, longitude, session.id],
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

app.post("/api/admin/users", async (req, res, next) => {
  const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = typeof req.body.password === "string" ? req.body.password : "";
  const displayName = typeof req.body.displayName === "string" ? req.body.displayName.trim() : "";
  if (!email || !password || password.length < 6 || displayName.length > 120) {
    return res.status(400).json({ error: "Admin email, password (6+ characters), and an optional name up to 120 characters are required." });
  }
  try {
    const session = await requireAdmin(req, res);
    if (!session) return;
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, display_name, role)
       VALUES ($1, $2, $3, 'Admin')
       RETURNING id, email, display_name, role, is_active, created_at`,
      [email, hashPassword(password), displayName || null],
    );
    return res.status(201).json({ user: result.rows[0] });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "An account with that email already exists." });
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
                b.assignment_distance_km, b.assignment_reason,
                b.delivery_partner_id, b.created_at, u.email AS producer_email,
                u.display_name AS producer_name, u.location_address AS producer_address,
                u.latitude AS source_lat, u.longitude AS source_lng,
                n.email AS ngo_email, n.display_name AS ngo_name,
                n.location_address AS ngo_address, n.latitude AS destination_lat,
                n.longitude AS destination_lng, d.email AS delivery_partner_email
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

app.post("/api/admin/ai-forecast", async (req, res, next) => {
  try {
    if (!await requireAdmin(req, res)) return;
    const batches = Array.isArray(req.body.batches) ? req.body.batches.slice(0, 100) : [];
    const requirements = Array.isArray(req.body.requirements) ? req.body.requirements.slice(0, 100) : [];
    const result = await requestPythonAi("/forecast", { batches, requirements });
    return res.json(result);
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
      const autoAssignedNgo = !Number.isInteger(requirementId) && batch.rows[0].assigned_ngo_id;
      const requirement = Number.isInteger(requirementId)
        ? await client.query(
          `SELECT r.*, u.email AS ngo_email, u.display_name AS ngo_name FROM food_requirements r
           JOIN users u ON u.id = r.ngo_id WHERE r.id = $1 AND r.status = 'Open'`,
          [requirementId],
        )
        : autoAssignedNgo
        ? await client.query(
          `SELECT NULL AS id, u.id AS ngo_id, u.email AS ngo_email, u.display_name AS ngo_name
           FROM users u WHERE u.id = $1 AND u.role = 'NGO'`,
          [batch.rows[0].assigned_ngo_id],
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
             delivery_otp = $4, assignment_reason = COALESCE(assignment_reason, 'Assigned manually by an administrator.')
         WHERE id = $5 AND status = 'Awaiting Pickup'
         RETURNING id, batch_code, assigned_ngo_id, delivery_partner_id, status`,
        [requirement.rows[0].ngo_id, requirement.rows[0].ngo_name || requirement.rows[0].ngo_email, driver.rows[0].id, deliveryOtp, batchId],
      );
      if (requirement.rows[0].id) {
        await client.query("UPDATE food_requirements SET status = 'Fulfilled' WHERE id = $1", [requirement.rows[0].id]);
      }
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

app.get("/api/admin/analytics", async (req, res, next) => {
  try {
    if (!await requireAdmin(req, res)) return;
    const [expiry, sensors, impact] = await Promise.all([
      pool.query(`SELECT id, item_name, category, quantity, unit, expires_on,
                         (expires_on - CURRENT_DATE) AS days_until_expiry
                  FROM producer_inventory
                  WHERE expires_on <= CURRENT_DATE + 3 ORDER BY expires_on ASC LIMIT 100`),
      pool.query(`SELECT COUNT(*)::INTEGER AS readings,
                         COUNT(*) FILTER (WHERE temperature_c > 5 OR humidity_percent > 65)::INTEGER AS unsafe
                  FROM iot_readings WHERE recorded_at >= NOW() - INTERVAL '7 days'`),
      pool.query(`SELECT COALESCE(SUM(quantity_value) FILTER (WHERE status = 'Delivered'), 0) AS rescued_servings,
                         COUNT(*) FILTER (WHERE status = 'Delivered')::INTEGER AS delivered_batches,
                         COUNT(*)::INTEGER AS total_batches
                  FROM food_batches`),
    ]);
    return res.json({ expiryAlerts: expiry.rows, sensorHealth: sensors.rows[0], impact: impact.rows[0] });
  } catch (error) { return next(error); }
});

app.get("/api/delivery/dashboard", async (req, res, next) => {
  try {
    const session = await requireRole(req, res, "delivery partner");
    if (!session) return;
    const [result, completed] = await Promise.all([
      pool.query(
      `SELECT b.id, b.batch_code, b.food_description, b.quantity,
              b.status, b.assigned_shelter, b.created_at,
              u.email AS producer_email, u.display_name AS producer_name,
              u.location_address AS producer_address, u.latitude AS source_lat,
              u.longitude AS source_lng, n.location_address AS ngo_address,
              n.latitude AS destination_lat, n.longitude AS destination_lng
       FROM food_batches b
       JOIN users u ON u.id = b.producer_id
       LEFT JOIN users n ON n.id = b.assigned_ngo_id
       WHERE b.delivery_partner_id = $1 AND b.status IN ('Awaiting Pickup', 'Picked Up')
       ORDER BY b.created_at ASC`,
      [session.id],
      ),
      pool.query(
        `SELECT COUNT(*)::INTEGER AS completed
         FROM food_batches
         WHERE delivery_partner_id = $1 AND status = 'Delivered'`,
        [session.id],
      ),
    ]);
    return res.json({ profile: session, assignments: result.rows, completed: completed.rows[0].completed });
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
    const session = await requireRole(req, res, "delivery partner");
    if (!session) return;
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

app.get("/api/delivery/batches/:id/route", async (req, res, next) => {
  const batchId = Number(req.params.id);
  if (!Number.isInteger(batchId)) return res.status(400).json({ error: "Invalid batch id." });
  try {
    const session = await requireRole(req, res, "delivery partner");
    if (!session) return;
    const batch = await pool.query(
      `SELECT b.id, b.batch_code, u.display_name AS producer_name, u.location_address AS producer_address,
              u.latitude AS source_lat, u.longitude AS source_lng,
              n.display_name AS ngo_name, n.location_address AS ngo_address,
              n.latitude AS destination_lat, n.longitude AS destination_lng
       FROM food_batches b JOIN users u ON u.id = b.producer_id
       LEFT JOIN users n ON n.id = b.assigned_ngo_id
       WHERE b.id = $1 AND b.delivery_partner_id = $2`,
      [batchId, session.id],
    );
    if (!batch.rows[0]) return res.status(404).json({ error: "Route assignment not found." });
    const item = batch.rows[0];
    const route = await requestPythonAi("/route-plan", { stops: [
      { type: "pickup", label: item.producer_name || item.producer_address || "Producer",
        latitude: item.source_lat, longitude: item.source_lng },
      { type: "dropoff", label: item.ngo_name || item.ngo_address || "NGO",
        latitude: item.destination_lat, longitude: item.destination_lng },
    ] });
    if (route.available) {
      await pool.query(
        `INSERT INTO route_plans (batch_id, delivery_partner_id, distance_km, duration_minutes, waypoints, provider)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [batchId, session.id, route.distanceKm || null, route.durationMinutes || null,
          JSON.stringify(route.stops || []), route.provider || "simulated"],
      );
    }
    return res.json({ batch: item, route });
  } catch (error) { return next(error); }
});

app.get("/api/food-producer/dashboard", async (req, res, next) => {
  try {
    const session = await requireRole(req, res, "FoodProducer");
    if (!session) return;
    const [batches, summary, inventory, readings, qualityImages] = await Promise.all([
      pool.query(
        `SELECT id, batch_code, food_description, food_category, waste_type, quantity, preparation_time,
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
      pool.query(
        `SELECT DISTINCT ON (sensor_id) id, sensor_id, temperature_c, humidity_percent,
                reading_source, recorded_at
         FROM iot_readings WHERE producer_id = $1
         ORDER BY sensor_id, recorded_at DESC`,
        [session.id],
      ),
      pool.query(
        `SELECT id, batch_id, file_name, mime_type, quality_score, detected_labels, notes, created_at
         FROM quality_image_records WHERE producer_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [session.id],
      ),
    ]);
    return res.json({ profile: session, batches: batches.rows, summary: summary.rows[0],
      inventory: inventory.rows, readings: readings.rows, qualityImages: qualityImages.rows });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/food-producer/sensors/readings", async (req, res, next) => {
  const temperature = Number(req.body.temperatureC);
  const humidity = Number(req.body.humidityPercent);
  const source = ["simulated", "manual", "device"].includes(req.body.source) ? req.body.source : "manual";
  if (!Number.isFinite(temperature) || !Number.isFinite(humidity) || humidity < 0 || humidity > 100) {
    return res.status(400).json({ error: "Temperature and humidity must be valid values." });
  }
  try {
    const session = await requireRole(req, res, "FoodProducer");
    if (!session) return;
    const result = await pool.query(
      `INSERT INTO iot_readings (producer_id, sensor_id, temperature_c, humidity_percent, reading_source)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, sensor_id, temperature_c, humidity_percent, reading_source, recorded_at`,
      [session.id, String(req.body.sensorId || "manual-sensor").slice(0, 80), temperature, humidity, source],
    );
    return res.status(201).json({ reading: result.rows[0], safe: temperature <= 5 && humidity <= 65 });
  } catch (error) { return next(error); }
});

app.post("/api/food-producer/quality-images", async (req, res, next) => {
  const fileName = typeof req.body.fileName === "string" ? req.body.fileName.trim() : "";
  if (!fileName) return res.status(400).json({ error: "An image file name is required." });
  try {
    const session = await requireRole(req, res, "FoodProducer");
    if (!session) return;
    const analysis = await requestPythonAi("/quality-check", { file_name: fileName, notes: req.body.notes || "" });
    const result = await pool.query(
      `INSERT INTO quality_image_records
       (producer_id, batch_id, file_name, mime_type, quality_score, detected_labels, notes)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       RETURNING id, batch_id, file_name, mime_type, quality_score, detected_labels, notes, created_at`,
      [session.id, Number.isInteger(Number(req.body.batchId)) ? Number(req.body.batchId) : null,
        fileName.slice(0, 255), String(req.body.mimeType || "image/jpeg"), analysis.qualityScore || null,
        JSON.stringify(analysis.detectedLabels || []), String(req.body.notes || "").slice(0, 500) || null],
    );
    return res.status(201).json({ image: result.rows[0], analysis });
  } catch (error) { return next(error); }
});

app.post("/api/food-producer/batches", async (req, res, next) => {
  const description = typeof req.body.foodDescription === "string" ? req.body.foodDescription.trim() : "";
  const category = typeof req.body.foodCategory === "string" ? req.body.foodCategory.trim() : "";
  const wasteType = typeof req.body.wasteType === "string" ? req.body.wasteType.trim() : "";
  const quantity = typeof req.body.quantity === "string" ? req.body.quantity.trim() : "";
  const preparationTime = typeof req.body.preparationTime === "string" ? req.body.preparationTime.trim() : "";
  const quantityValue = Number.parseFloat(quantity.match(/[\d.]+/)?.[0] || "");
  if (!description || !category || !["Edible", "Non-edible"].includes(wasteType) || !quantity || !preparationTime || !Number.isFinite(quantityValue) || quantityValue <= 0) {
    return res.status(400).json({ error: "Food description, category, waste type, quantity, and preparation time are required." });
  }
  try {
    const session = await requireRole(req, res, "FoodProducer");
    if (!session) return;
    const otp = String(Math.floor(1000 + Math.random() * 9000));
    const result = await pool.query(
      `INSERT INTO food_batches
       (producer_id, food_description, food_category, waste_type, quantity, quantity_value, preparation_time, status, release_otp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'Awaiting Pickup', $8)
       RETURNING id, batch_code, food_description, food_category, waste_type, quantity, preparation_time, status, release_otp, created_at`,
      [session.id, description, category, wasteType, quantity, quantityValue, preparationTime, otp],
    );
    const location = await pool.query(
      "SELECT latitude AS source_latitude, longitude AS source_longitude FROM users WHERE id = $1",
      [session.id],
    );
    const autoAssignment = await automaticallyAssignNgo({
      ...result.rows[0],
      ...location.rows[0],
    });
    return res.status(201).json({ batch: autoAssignment.batch || result.rows[0], autoAssignment });
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

app.get("/api/ngo/marketplace", async (req, res, next) => {
  try {
    if (!await requireRole(req, res, "NGO")) return;
    const result = await pool.query(
      `SELECT b.id, b.batch_code, b.food_description, b.food_category, b.quantity,
              b.quantity_value, b.preparation_time, b.status, b.created_at,
              u.display_name AS producer_name, u.email AS producer_email
       FROM food_batches b
       JOIN users u ON u.id = b.producer_id
       WHERE b.status = 'Awaiting Pickup'
       ORDER BY b.created_at DESC`,
    );
    const recentVolume = result.rows
      .filter((batch) => Date.now() - new Date(batch.created_at).getTime() <= 7 * 24 * 60 * 60 * 1000)
      .reduce((sum, batch) => sum + Number(batch.quantity_value), 0);
    return res.json({ listings: result.rows, predictedExcessServings: Math.round(recentVolume / 7) });
  } catch (error) {
    return next(error);
  }
});

app.get("/api/ngo/marketplace/recommendations", async (req, res, next) => {
  try {
    const session = await requireRole(req, res, "NGO");
    if (!session) return;
    const [listings, requirements] = await Promise.all([
      pool.query(
        `SELECT b.id, b.food_description, b.food_category, b.quantity, b.quantity_value,
                b.waste_type, b.preparation_time
         FROM food_batches b WHERE b.status = 'Awaiting Pickup'
         ORDER BY b.created_at DESC LIMIT 100`,
      ),
      pool.query(
        `SELECT food_description, food_category, servings, needed_by, notes
         FROM food_requirements WHERE ngo_id = $1 AND status = 'Open'
         ORDER BY needed_by ASC LIMIT 50`,
        [session.id],
      ),
    ]);
    const result = await requestPythonAi("/match", { listings: listings.rows, requirements: requirements.rows });
    return res.json(result);
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
  const serveDashboard = (req, res, next) => {
    getSession(req).then((session) => {
      if (!session) return res.redirect("/");
      if (session.role !== role) return res.status(403).send("Forbidden");
      return res.sendFile(`${__dirname}/public/dashboards/${dashboardFiles[role]}`);
    }).catch(next);
  };
  app.get(route, (req, res) => res.redirect(`${route}/overview`));
  const sectionRoutes = {
    Admin: ["overview", "operations", "intelligence", "sustainability", "users"],
    NGO: ["overview", "incoming-food", "marketplace", "post-requirement", "requests"],
    FoodProducer: ["overview", "planning", "storage-tools", "stock", "surplus", "batches"],
    "delivery partner": ["overview", "assignments", "route", "verification"],
  };
  for (const section of sectionRoutes[role] || []) {
    app.get(`${route}/${section}`, serveDashboard);
  }
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
