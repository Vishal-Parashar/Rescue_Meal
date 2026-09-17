async function request(url, options) {
  const response = await fetch(url, { credentials: "same-origin", ...options });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed.");
  return result;
}

function setStatus(message, error = false) {
  const status = document.querySelector("#admin-status");
  if (status) {
    status.textContent = message;
    status.style.color = error ? "#b34c4c" : "";
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  }[character]));
}

function formatNgoName(ngoName, ngoEmail) {
  const name = String(ngoName || "").trim();
  const email = String(ngoEmail || "").trim();
  if (name) return email ? `${name} (${email})` : name;
  return email || "NGO name not set";
}

function normalizeFoodCategory(category) {
  const value = String(category || "").trim().toLowerCase();
  if (["cooked-hot", "cooked-cold", "cooked meal"].includes(value)) return "cooked";
  if (["bakery", "bakery products"].includes(value)) return "bakery";
  if (["raw", "fresh produce"].includes(value)) return "fresh";
  if (["packaged", "packaged food"].includes(value)) return "packaged";
  if (["water", "drinking water"].includes(value)) return "water";
  return value;
}

function renderOperations(data) {
  const { metrics, batches, requirements, deliveryPartners } = data;
  const total = Math.max(metrics.totalPrepared, 1);
  document.querySelector("#total-prepared").textContent = `${metrics.totalPrepared} servings`;
  document.querySelector("#pending-allocations").textContent = `${metrics.pendingAllocations} Batches`;
  document.querySelector("#dispatch-efficiency").textContent = `${metrics.dispatchEfficiency}%`;
  document.querySelector("#prepared-bar").style.width = "100%";
  document.querySelector("#prepared-value").textContent = `${metrics.totalPrepared} servings`;
  document.querySelector("#need-bar").style.width = `${Math.min(100, (metrics.pendingAllocations / Math.max(batches.length, 1)) * 100)}%`;
  document.querySelector("#need-value").textContent = `${metrics.pendingAllocations} pending`;
  const delivered = batches.filter((batch) => batch.status === "Delivered").reduce((sum, batch) => sum + Number(batch.quantity_value), 0);
  document.querySelector("#risk-bar").style.width = `${Math.min(100, (delivered / total) * 100)}%`;
  document.querySelector("#risk-value").textContent = `${delivered} delivered`;

  const table = document.querySelector("#matchingTableBody");
  table.innerHTML = batches.length ? batches.map((batch) => `
    <tr data-batch-id="${batch.id}">
      <td class="bold">#${escapeHtml(batch.batch_code)}</td>
      <td><strong>${escapeHtml(batch.producer_name || batch.producer_email)}</strong><br><small>${escapeHtml(batch.producer_email)}</small></td>
      <td>${new Date(batch.created_at).toLocaleDateString()}</td>
      <td><select class="custom-select requirement-select" ${batch.status !== "Awaiting Pickup" ? "disabled" : ""}>
        <option value="">${batch.status === "Awaiting Pickup" ? "Choose NGO requirement" : `Assigned NGO: ${escapeHtml(formatNgoName(batch.ngo_name, batch.ngo_email))}`}</option>
        ${(requirements || []).filter((item) => normalizeFoodCategory(item.food_category) === normalizeFoodCategory(batch.food_category) && Number(item.servings) <= Number(batch.quantity_value)).map((item) => `<option value="${item.id}">NGO: ${escapeHtml(formatNgoName(item.ngo_name, item.ngo_email))} · ${escapeHtml(item.food_description)} · ${item.servings} servings</option>`).join("")}
      </select></td>
      <td><select class="custom-select driver-select" ${batch.status !== "Awaiting Pickup" ? "disabled" : ""}>
        <option value="">Auto-assign driver</option>
        ${(deliveryPartners || []).map((driver) => `<option value="${driver.id}">${escapeHtml(driver.email)}</option>`).join("")}
      </select><button class="btn-assign" data-assign="${batch.id}" ${batch.status !== "Awaiting Pickup" ? "disabled" : ""}>${batch.status === "Awaiting Pickup" ? "Assign" : escapeHtml(batch.status)}</button></td>
    </tr>`).join("") : '<tr><td colspan="5">No producer batches have been submitted.</td></tr>';
}

function renderUsers(users) {
  const table = document.querySelector("#usersTableBody");
  document.querySelector("#user-count").textContent = `${users.length} users`;
  table.innerHTML = users.length ? users.map((user) => `
    <tr data-user-id="${user.id}">
      <td>${escapeHtml(user.display_name || "Not set")}</td>
      <td>${escapeHtml(user.email)}</td>
      <td>
        <select class="custom-select user-role" ${user.is_active ? "" : "disabled"}>
          ${["Admin", "NGO", "FoodProducer", "delivery partner"].map((role) => `
            <option value="${escapeHtml(role)}" ${user.role === role ? "selected" : ""}>${escapeHtml(role)}</option>
          `).join("")}
        </select>
      </td>
      <td><button type="button" class="status-pill ${user.is_active ? "active" : "inactive"} user-status">${user.is_active ? "Active" : "Inactive"}</button></td>
      <td>${new Date(user.created_at).toLocaleDateString()}</td>
      <td><button type="button" class="delete-button user-delete">Delete</button></td>
    </tr>
  `).join("") : '<tr><td colspan="6">No users found.</td></tr>';
}

async function loadDashboard() {
  try {
    const profile = await request("/api/profile");
    document.querySelector("#profile-email").textContent = profile.email;
    document.querySelector("#profile-role").textContent = profile.role;
    document.querySelector("#header-profile-avatar").textContent = profile.email[0].toUpperCase();
    const [operations, users] = await Promise.all([
      request("/api/admin/operations"),
      request("/api/admin/users"),
    ]);
    renderOperations(operations);
    renderUsers(users.users);
  } catch (error) {
    if (error.message === "Authentication required.") {
      window.location.replace("/");
      return;
    }
    setStatus(error.message, true);
  }
}

let refreshInProgress = false;
async function refreshOperations() {
  if (refreshInProgress || document.hidden) return;
  if (document.activeElement && document.activeElement.classList.contains("requirement-select")) return;
  refreshInProgress = true;
  try {
    const [operations, users] = await Promise.all([
      request("/api/admin/operations"),
      request("/api/admin/users"),
    ]);
    renderOperations(operations);
    renderUsers(users.users);
  } catch (error) {
    if (error.message === "Authentication required.") {
      window.location.replace("/");
      return;
    }
    setStatus(error.message, true);
  } finally {
    refreshInProgress = false;
  }
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

document.querySelector("#matchingTableBody").addEventListener("click", async (event) => {
  const batchId = event.target.dataset.assign;
  if (!batchId) return;
  const row = event.target.closest("tr");
  const requirementId = row.querySelector(".requirement-select").value;
  if (!requirementId) {
    setStatus("Choose a matching NGO requirement before assigning the batch.", true);
    return;
  }
  try {
    await request(`/api/admin/operations/${batchId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requirementId, deliveryPartnerId: row.querySelector(".driver-select").value }),
    });
    setStatus("Batch assigned successfully.");
    await loadDashboard();
  } catch (error) {
    setStatus(error.message, true);
  }
});

document.querySelector("#usersTableBody").addEventListener("change", async (event) => {
  if (!event.target.classList.contains("user-role")) return;
  const row = event.target.closest("tr");
  try {
    await request(`/api/admin/users/${row.dataset.userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: event.target.value }),
    });
    setStatus("User role updated.");
  } catch (error) {
    setStatus(error.message, true);
    await refreshOperations();
  }
});

document.querySelector("#usersTableBody").addEventListener("click", async (event) => {
  const row = event.target.closest("tr");
  if (!row) return;
  if (event.target.classList.contains("user-status")) {
    const button = event.target;
    button.disabled = true;
    try {
      await request(`/api/admin/users/${row.dataset.userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: button.classList.contains("inactive") }),
      });
      await refreshOperations();
      setStatus("User status updated.");
    } catch (error) {
      button.disabled = false;
      setStatus(error.message, true);
    }
  }
  if (event.target.classList.contains("user-delete")) {
    if (!window.confirm("Delete this user? This cannot be undone.")) return;
    event.target.disabled = true;
    try {
      await request(`/api/admin/users/${row.dataset.userId}`, { method: "DELETE" });
      await refreshOperations();
      setStatus("User deleted.");
    } catch (error) {
      event.target.disabled = false;
      setStatus(error.message, true);
    }
  }
});

loadDashboard();
window.setInterval(refreshOperations, 5000);
