const logoutButton = document.querySelector("#logout-button");
const requirementForm = document.querySelector("#requirement-form");
const requirementsList = document.querySelector("#requirements-list");
const statusMessage = document.querySelector("#requirement-status");
const isLocalhost = ["localhost", "127.0.0.1"].includes(window.location.hostname);
const isExpressDashboard = isLocalhost && window.location.port === "3000";
const apiOrigin = isExpressDashboard ? "" : "http://localhost:3000";

document.querySelectorAll("[data-section-target]").forEach((button) => {
  button.addEventListener("click", () => {
    const target = document.querySelector(`#${button.dataset.sectionTarget}`);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    document.querySelectorAll("[data-section-target]").forEach((menuButton) => {
      menuButton.classList.toggle("active", menuButton === button);
    });
  });
});

if (isLocalhost && !isExpressDashboard) {
  window.location.replace(`http://localhost:3000/dashboard/ngo`);
  throw new Error("Redirecting NGO dashboard to the Express server.");
}

async function request(url, options) {
  const response = await fetch(`${apiOrigin}${url}`, {
    credentials: "same-origin",
    ...options,
    headers: { Accept: "application/json", ...(options?.headers || {}) },
  });
  const contentType = response.headers.get("content-type") || "";
  const responseText = await response.text();
  let result = {};

  if (responseText) {
    if (!contentType.includes("application/json")) {
      throw new Error(`Profile request returned HTML instead of JSON (HTTP ${response.status}). Open the NGO dashboard at http://localhost:3000/dashboard/ngo.`);
    }
    try {
      result = JSON.parse(responseText);
    } catch {
      throw new Error(`Profile request returned an invalid JSON response (HTTP ${response.status}).`);
    }
  }

  if (!response.ok) throw new Error(result.error || "Request failed.");
  return result;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  }[character]));
}

function renderRequirements(requirements) {
  if (!requirements.length) {
    requirementsList.innerHTML = '<p class="empty-state">No requirements submitted yet.</p>';
    return;
  }
  requirementsList.innerHTML = requirements.map((item) => `
    <article class="requirement-item">
      <div><h3>${escapeHtml(item.food_description)}</h3><p>${escapeHtml(item.food_category)} · ${item.servings} servings</p></div>
      <span class="requirement-status">${escapeHtml(item.status)}</span>
      <time>Needed by ${new Date(item.needed_by).toLocaleString()}</time>
      ${item.notes ? `<p class="requirement-notes">${escapeHtml(item.notes)}</p>` : ""}
    </article>
  `).join("");
}

function renderDeliveries(deliveries) {
  const existing = document.querySelector("#ngo-deliveries");
  if (!existing) return;
  const assigned = deliveries || [];
  existing.innerHTML = assigned.length ? assigned.map((item) => `
    <article class="requirement-item">
      <h3>#${escapeHtml(item.batch_code)} · ${escapeHtml(item.food_description)}</h3>
      <p>${escapeHtml(item.quantity)} · From ${escapeHtml(item.producer_name || item.producer_email)} · ${escapeHtml(item.status)}</p>
      ${item.status === "Picked Up" ? `<p class="requirement-notes"><strong>Delivery OTP:</strong> ${escapeHtml(item.delivery_otp)}</p>` : ""}
    </article>`).join("") : '<p class="empty-state">No matched surplus deliveries yet.</p>';
}

function renderMarketplace(listings, predictedExcessServings) {
  document.querySelector("#marketplace-forecast").textContent = predictedExcessServings
    ? `Prediction: about ${predictedExcessServings} servings per day based on recent producer submissions.`
    : "Prediction: more producer history is needed to estimate excess food.";
  const list = document.querySelector("#marketplace-list");
  list.innerHTML = listings.length ? listings.map((item) => `
    <article class="marketplace-item">
      <div>
        <h3>${escapeHtml(item.food_description)}</h3>
        <p>${escapeHtml(item.food_category)} · ${escapeHtml(item.quantity)} · ${escapeHtml(item.producer_name || item.producer_email)}</p>
      </div>
      <span class="marketplace-status">Available now</span>
    </article>
  `).join("") : '<p class="empty-state">No excess food is available right now.</p>';
}

function renderAiRecommendations(result) {
  const target = document.querySelector("#ai-match-recommendations");
  if (!result.available) {
    target.innerHTML = `<strong>AI matching:</strong> ${escapeHtml(result.error)}`;
    return;
  }
  const data = result.data || {};
  const matches = Array.isArray(data.matches) ? data.matches : [];
  const details = matches.length
    ? ` ${matches.map((match) => `${escapeHtml(match.priority || "Suggested")} priority batch #${escapeHtml(match.batchId)}: ${escapeHtml(match.reason)}`).join(" · ")}`
    : "";
  target.innerHTML = `<strong>AI matching:</strong> ${escapeHtml(data.summary || "No matching recommendation is available.")}${details}`;
}

async function loadDashboard() {
  const result = await request("/api/ngo/requirements");
  document.querySelector("#profile-name").value = result.profile.display_name || "";
  document.querySelector("#profile-email").textContent = result.profile.email;
  document.querySelector("#profile-role").textContent = result.profile.role;
  document.querySelector("#profile-avatar").textContent = result.profile.email[0].toUpperCase();
  document.querySelector("#header-profile-email").textContent = result.profile.email;
  document.querySelector("#header-profile-role").textContent = result.profile.role;
  document.querySelector("#header-profile-avatar").textContent = result.profile.email[0].toUpperCase();
  renderRequirements(result.requirements);
  renderDeliveries(result.deliveries);
  await loadMarketplace();
}

async function loadMarketplace() {
  const result = await request("/api/ngo/marketplace");
  renderMarketplace(result.listings, result.predictedExcessServings);
  try {
    const recommendations = await request("/api/ngo/marketplace/recommendations");
    renderAiRecommendations(recommendations);
  } catch (error) {
    renderAiRecommendations({ available: false, error: error.message });
  }
}

logoutButton.addEventListener("click", async () => {
  logoutButton.disabled = true;
  try { await request("/api/auth/logout", { method: "POST" }); } finally { window.location.replace("/"); }
});

document.querySelector("#profile-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = document.querySelector("#profile-status");
  try {
    const result = await request("/api/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: document.querySelector("#profile-name").value }),
    });
    document.querySelector("#profile-name").value = result.profile.display_name;
    status.textContent = "Name saved.";
    status.style.color = "";
  } catch (error) {
    status.textContent = error.message;
    status.style.color = "#b34c4c";
  }
});
document.querySelector("#profile-button").addEventListener("click", () => {
  const panel = document.querySelector("#header-profile-panel");
  panel.hidden = !panel.hidden;
});

requirementForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = requirementForm.querySelector("button[type='submit']");
  submitButton.disabled = true;
  statusMessage.textContent = "Submitting...";
  try {
    await request("/api/ngo/requirements", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(requirementForm))),
    });
    requirementForm.reset();
    statusMessage.textContent = "Requirement submitted successfully.";
    await loadDashboard();
  } catch (error) {
    statusMessage.textContent = error.message;
    statusMessage.style.color = "#b34c4c";
  } finally {
    submitButton.disabled = false;
  }
});

document.querySelector("#refresh-requirements").addEventListener("click", loadDashboard);
document.querySelector("#refresh-marketplace").addEventListener("click", loadMarketplace);
loadDashboard().catch((error) => { statusMessage.textContent = error.message; });
