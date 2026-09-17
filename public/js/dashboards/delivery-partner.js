const logoutButton = document.querySelector("#logout-button");
logoutButton.addEventListener("click", async () => {
  logoutButton.disabled = true;
  try {
    const response = await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    if (!response.ok) throw new Error("Sign out failed.");
  } finally {
    window.location.replace("/");
  }
});

(async () => {
  const response = await fetch("/api/profile", { credentials: "same-origin" });
  if (!response.ok) return;
  const profile = await response.json();
  document.querySelector("#header-profile-email").textContent = profile.email;
  document.querySelector("#header-profile-role").textContent = profile.role;
  document.querySelector("#header-profile-avatar").textContent = profile.email[0].toUpperCase();
})();

document.querySelector("#profile-button").addEventListener("click", () => {
  const panel = document.querySelector("#header-profile-panel");
  panel.hidden = !panel.hidden;
});
const assignmentList = document.querySelector("#assignment-list");
const deliveryStatus = document.querySelector("#delivery-status");
let assignments = [];

async function request(url, options) {
  const response = await fetch(url, { credentials: "same-origin", ...options });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed.");
  return result;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  }[character]));
}

function renderAssignments() {
  document.querySelector("#active-assignment").textContent = `${assignments.length} Batches`;
  const batchSelect = document.querySelector("#active-batch");
  batchSelect.innerHTML = assignments.length
    ? assignments.map((batch) => `<option value="${batch.id}">#${escapeHtml(batch.batch_code)} · ${escapeHtml(batch.assigned_shelter || "Shelter pending")}</option>`).join("")
    : '<option value="">No active assignments</option>';
  batchSelect.disabled = !assignments.length;
  if (!assignments.length) {
    assignmentList.innerHTML = '<p class="empty-state">No active assignments. Admin assignments will appear here.</p>';
    return;
  }
  assignmentList.innerHTML = assignments.map((batch) => `
    <article class="assignment-item">
      <strong>#${escapeHtml(batch.batch_code)} · ${escapeHtml(batch.food_description)}</strong>
      <span>${escapeHtml(batch.quantity)} · Pickup: ${escapeHtml(batch.producer_email)}</span>
      <span>Drop: ${escapeHtml(batch.assigned_shelter || "NGO pending")} · ${escapeHtml(batch.status)}</span>
    </article>
  `).join("");
}

async function loadDashboard() {
  const result = await request("/api/delivery/dashboard");
  assignments = result.assignments;
  document.querySelector("#header-profile-email").textContent = result.profile.email;
  document.querySelector("#header-profile-role").textContent = result.profile.role;
  document.querySelector("#header-profile-avatar").textContent = result.profile.email[0].toUpperCase();
  document.querySelector("#driver-name").textContent = result.profile.email;
  document.querySelector("#on-time-completion").textContent = assignments.length ? "Ready" : "100%";
  renderAssignments();
}

document.querySelector("#logout-button").addEventListener("click", async () => {
  document.querySelector("#logout-button").disabled = true;
  try {
    await request("/api/auth/logout", { method: "POST" });
  } finally {
    window.location.replace("/");
  }
});

document.querySelector("#profile-button").addEventListener("click", () => {
  const panel = document.querySelector("#header-profile-panel");
  panel.hidden = !panel.hidden;
});

document.querySelector(".btn-verify").addEventListener("click", async () => {
  const codeInput = document.querySelector("#shelterOtp");
  const code = codeInput.value.trim();
  const batchId = document.querySelector("#active-batch").value;
  const assignment = assignments.find((item) => String(item.id) === String(batchId));
  if (!batchId) {
    deliveryStatus.textContent = "There are no active assignments to verify.";
    deliveryStatus.style.color = "#b34c4c";
    return;
  }
  if (!code) {
    deliveryStatus.textContent = assignment?.status === "Picked Up" ? "Enter the delivery OTP provided by the NGO." : "Enter the pickup OTP provided by the producer.";
    deliveryStatus.style.color = "#b34c4c";
    return;
  }
  try {
    await request(`/api/delivery/batches/${batchId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage: assignment.status === "Picked Up" ? "delivery" : "pickup", otp: code }),
    });
    codeInput.value = "";
    deliveryStatus.style.color = "";
    deliveryStatus.textContent = assignment.status === "Picked Up" ? "Delivery OTP verified. The batch was delivered to the NGO." : "Pickup OTP verified. The batch is now in transit.";
    await loadDashboard();
  } catch (error) {
    deliveryStatus.textContent = error.message;
    deliveryStatus.style.color = "#b34c4c";
  }
});

loadDashboard().catch((error) => {
  deliveryStatus.textContent = error.message;
  deliveryStatus.style.color = "#b34c4c";
});
