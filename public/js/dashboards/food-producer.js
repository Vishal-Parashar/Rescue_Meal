const logoutButton = document.querySelector("#logout-button");
const surplusForm = document.querySelector("#surplusForm");
const batchesTable = document.querySelector("#batches-table");
const inventoryForm = document.querySelector("#inventory-form");
const inventoryTable = document.querySelector("#inventory-table");
const inventoryStatus = document.querySelector("#inventory-status");
const barcodeInput = document.querySelector("#inventory-barcode");
const barcodeScanner = document.querySelector("#barcode-scanner");
const barcodeVideo = document.querySelector("#barcode-video");
const barcodeStatus = document.querySelector("#barcode-status");
let barcodeStream = null;
let barcodeDetector = null;
let barcodeFrame = null;

const today = new Date().toISOString().slice(0, 10);
document.querySelector("#inventory-expiry").min = today;

async function request(url, options) {
    const response = await fetch(url, { credentials: "same-origin", ...options });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Request failed.");
    return result;
}

function renderSummary(summary) {
    document.querySelector("#today-batches").textContent = summary.today_batches || 0;
    document.querySelector("#today-quantity").textContent = summary.today_quantity || 0;
    document.querySelector("#awaiting-servings").textContent = summary.awaiting_servings || 0;
    document.querySelector("#salvaged-meals").textContent = summary.salvaged_meals || 0;
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
    }[character]));
}

function formatInventoryDate(value) {
    const dateKey = String(value || "").slice(0, 10);
    const date = new Date(`${dateKey}T00:00:00`);
    return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleDateString();
}

function renderBatches(batches) {
    if (!batches.length) {
        batchesTable.innerHTML = '<tr><td colspan="6">No food batches uploaded yet.</td></tr>';
        return;
    }

    batchesTable.innerHTML = batches.map((batch) => `
        <tr>
            <td><strong>#${escapeHtml(batch.batch_code)}</strong></td>
            <td>${escapeHtml(batch.food_description)}</td>
            <td>${escapeHtml(batch.quantity)}</td>
            <td><span class="status ${batch.status === "Delivered" ? "status-green" : "status-orange"}">${escapeHtml(batch.status)}</span></td>
            <td><input type="text" class="otp-input" value="${escapeHtml(batch.release_otp)}" maxlength="4" readonly></td>
            <td>${batch.status === "Awaiting Pickup"
                ? `<button type="button" class="delete-batch-button" data-batch-id="${batch.id}">Delete</button>`
                : '<span class="action-muted">Locked</span>'}</td>
        </tr>
    `).join("");
}

function renderInventory(items) {
    if (!items.length) {
            inventoryTable.innerHTML = '<tr><td colspan="6">No inventory items added yet.</td></tr>';
            return;
    }

    const batches = items.reduce((groups, item) => {
            const date = String(item.expires_on || "").slice(0, 10);
            if (!groups[date]) groups[date] = [];
            groups[date].push(item);
            return groups;
    }, {});

    inventoryTable.innerHTML = Object.entries(batches).map(([date, dateItems]) => `
            <tr class="inventory-date-row">
                <th colspan="6">Expiry batch: ${formatInventoryDate(date)}</th>
            </tr>
            ${dateItems.map((item) => `
                <tr>
                    <td><strong>${escapeHtml(item.item_name)}</strong></td>
                    <td>${escapeHtml(item.category)}</td>
                    <td>${escapeHtml(item.barcode || "—")}</td>
                    <td>${escapeHtml(item.quantity)} ${escapeHtml(item.unit)}</td>
                    <td>${formatInventoryDate(item.expires_on)}</td>
                    <td><button type="button" class="delete-batch-button delete-inventory" data-inventory-id="${item.id}">Delete</button></td>
                </tr>`).join("")}
    `).join("");
}

async function loadDashboard() {
    const result = await request("/api/food-producer/dashboard");
    const displayName = result.profile.display_name || "";
    document.querySelector("#profile-name").value = displayName;
    document.querySelector("#profile-email").textContent = result.profile.email;
    document.querySelector("#header-profile-role").textContent = result.profile.role;
    document.querySelector("#header-profile-avatar").textContent = result.profile.email[0].toUpperCase();
    renderSummary(result.summary);
    renderBatches(result.batches);
    renderInventory(result.inventory);
}

let refreshInProgress = false;
async function refreshBatches() {
    if (refreshInProgress || document.hidden) return;
    refreshInProgress = true;
    try {
        const result = await request("/api/food-producer/dashboard");
        renderSummary(result.summary);
        renderBatches(result.batches);
        renderInventory(result.inventory);
    } catch (error) {
        if (error.message === "Authentication required.") {
            window.location.replace("/");
            return;
        }
        window.console.error("Unable to refresh food batches.", error);
    } finally {
        refreshInProgress = false;
    }
}

logoutButton.addEventListener("click", async () => {
    logoutButton.disabled = true;
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

surplusForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = surplusForm.querySelector(".upload-btn");
    submitButton.disabled = true;
    try {
        await request("/api/food-producer/batches", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                foodDescription: document.querySelector("#foodDescription").value,
                foodCategory: document.querySelector("#foodCategory").value,
                quantity: document.querySelector("#quantity").value,
                preparationTime: document.querySelector("#timestamp").value,
            }),
        });

        surplusForm.reset();
        await loadDashboard();
        window.alert("Surplus food uploaded successfully.");
    } catch (error) {
        window.alert(error.message);
    } finally {
        submitButton.disabled = false;
    }
});

inventoryForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = inventoryForm.querySelector("button");
    button.disabled = true;
    inventoryStatus.textContent = "Adding stock...";
    inventoryStatus.style.color = "";
    try {
        await request("/api/food-producer/inventory", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                itemName: document.querySelector("#inventory-item").value,
                category: document.querySelector("#inventory-category").value,
                quantity: document.querySelector("#inventory-quantity").value,
                unit: document.querySelector("#inventory-unit").value,
                expiresOn: document.querySelector("#inventory-expiry").value,
                barcode: barcodeInput.value,
            }),
        });

        function stopBarcodeScanner() {
            if (barcodeFrame) cancelAnimationFrame(barcodeFrame);
            barcodeFrame = null;
            if (barcodeStream) barcodeStream.getTracks().forEach((track) => track.stop());
            barcodeStream = null;
            barcodeVideo.srcObject = null;
            barcodeScanner.hidden = true;
        }

        async function scanBarcode() {
            if (!("BarcodeDetector" in window)) {
                barcodeStatus.textContent = "Camera scanning is not supported here. Enter the barcode manually.";
                barcodeStatus.style.color = "#b34c4c";
                return;
            }
            try {
                barcodeDetector = new BarcodeDetector();
                barcodeStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
                barcodeVideo.srcObject = barcodeStream;
                barcodeScanner.hidden = false;
                barcodeStatus.textContent = "Point the camera at a barcode.";
                barcodeStatus.style.color = "";
                await barcodeVideo.play();
                const detect = async () => {
                    if (!barcodeStream) return;
                    const results = await barcodeDetector.detect(barcodeVideo);
                    if (results[0]?.rawValue) {
                        barcodeInput.value = results[0].rawValue;
                        barcodeStatus.textContent = `Scanned: ${results[0].rawValue}`;
                        stopBarcodeScanner();
                        return;
                    }
                    barcodeFrame = requestAnimationFrame(detect);
                };
                detect().catch(() => {
                    barcodeStatus.textContent = "Unable to read this barcode. Enter it manually.";
                    barcodeStatus.style.color = "#b34c4c";
                });
            } catch (error) {
                stopBarcodeScanner();
                barcodeStatus.textContent = error.name === "NotAllowedError"
                    ? "Camera permission was denied. Enter the barcode manually."
                    : "Unable to start the camera. Enter the barcode manually.";
                barcodeStatus.style.color = "#b34c4c";
            }
        }

        document.querySelector("#scan-barcode").addEventListener("click", scanBarcode);
        document.querySelector("#stop-barcode").addEventListener("click", stopBarcodeScanner);
        inventoryForm.reset();
        inventoryStatus.textContent = "Stock added.";
        await loadDashboard();
    } catch (error) {
        inventoryStatus.textContent = error.message;
        inventoryStatus.style.color = "#b34c4c";
    } finally {
        button.disabled = false;
    }
});

document.addEventListener("click", (event) => {
    if (event.target.classList.contains("otp-input")) {
        window.alert("Disclose the OTP only after the driver arrives and presents insulated food carriers.");
    }
});

batchesTable.addEventListener("click", async (event) => {
    const button = event.target.closest(".delete-batch-button");
    if (!button) return;
    if (!window.confirm("Delete this food batch? This cannot be undone.")) return;
    button.disabled = true;
    try {
        await request(`/api/food-producer/batches/${button.dataset.batchId}`, { method: "DELETE" });
        await loadDashboard();
    } catch (error) {
        button.disabled = false;
        window.alert(error.message);
    }
});

inventoryTable.addEventListener("click", async (event) => {
    const button = event.target.closest(".delete-inventory");
    if (!button || !window.confirm("Delete this inventory item?")) return;
    button.disabled = true;
    try {
        await request(`/api/food-producer/inventory/${button.dataset.inventoryId}`, { method: "DELETE" });
        await loadDashboard();
    } catch (error) {
        button.disabled = false;
        inventoryStatus.textContent = error.message;
        inventoryStatus.style.color = "#b34c4c";
    }
});

loadDashboard().catch((error) => {
    if (error.message === "Authentication required.") {
        window.location.replace("/");
        return;
    }
    window.alert(error.message);
});
window.setInterval(refreshBatches, 5000);
