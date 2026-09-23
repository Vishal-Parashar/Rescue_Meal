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
let inventoryFilter = "all";
let inventorySearch = "";

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

function stopBarcodeScanner() {
    if (barcodeFrame) cancelAnimationFrame(barcodeFrame);
    barcodeFrame = null;
    if (barcodeStream) barcodeStream.getTracks().forEach((track) => track.stop());
    barcodeStream = null;
    barcodeVideo.srcObject = null;
    barcodeScanner.hidden = true;
}

async function scanBarcode() {
    if (!navigator.mediaDevices?.getUserMedia) {
        barcodeStatus.textContent = "Camera access is not supported here. Enter the barcode manually.";
        barcodeStatus.style.color = "#b34c4c";
        return;
    }

    try {
        barcodeStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: "environment" } },
            audio: false,
        });
        barcodeVideo.srcObject = barcodeStream;
        barcodeScanner.hidden = false;
        barcodeStatus.textContent = "Point the camera at a barcode, or enter it manually below.";
        barcodeStatus.style.color = "";
        await barcodeVideo.play();

        if (!("BarcodeDetector" in window)) {
            barcodeStatus.textContent = "Camera opened. Automatic barcode detection is unavailable in this browser.";
            return;
        }

        barcodeDetector = new BarcodeDetector();
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
            barcodeStatus.textContent = "Camera is open, but this barcode could not be read. Enter it manually.";
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

function inventoryFlags(item) {
    const quantity = Number(item.quantity);
    const expiry = new Date(`${String(item.expires_on || "").slice(0, 10)}T00:00:00`);
    const daysUntilExpiry = Math.ceil((expiry - new Date(`${today}T00:00:00`)) / 86400000);
    return {
        low: Number.isFinite(quantity) && quantity <= 5,
        expiring: Number.isFinite(daysUntilExpiry) && daysUntilExpiry <= 3,
    };
}

function updateInventoryInsights(items) {
    document.querySelector("#inventory-total").textContent = items.length;
    document.querySelector("#inventory-low").textContent = items.filter((item) => inventoryFlags(item).low).length;
    document.querySelector("#inventory-expiring").textContent = items.filter((item) => inventoryFlags(item).expiring).length;
}

function requestPickup(item) {
    document.querySelector("#foodDescription").value = item.item_name;
    document.querySelector("#foodCategory").value = item.category.toLowerCase().includes("raw") ? "raw" : "packaged";
    document.querySelector("#quantity").value = `${item.quantity} ${item.unit}`;
    document.querySelector("#timestamp").value = "Ready for pickup";
    document.querySelector(".upload-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    window.alert("Pickup details added to the surplus form. Review them and submit to request pickup.");
}

function renderBatches(batches) {
    if (!batches.length) {
        batchesTable.innerHTML = '<tr><td colspan="7">No food batches uploaded yet.</td></tr>';
        return;
    }

    batchesTable.innerHTML = batches.map((batch) => `
        <tr>
            <td><strong>#${escapeHtml(batch.batch_code)}</strong></td>
            <td>${escapeHtml(batch.food_description)}</td>
            <td>${escapeHtml(batch.waste_type || "Edible")}</td>
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
    window.producerInventory = items;
    updateInventoryInsights(items);
    const visibleItems = items.filter((item) => {
        const matchesSearch = !inventorySearch
            || `${item.item_name} ${item.category}`.toLowerCase().includes(inventorySearch);
        const flags = inventoryFlags(item);
        const matchesFilter = inventoryFilter === "all"
            || (inventoryFilter === "low" && flags.low)
            || (inventoryFilter === "expiring" && flags.expiring);
        return matchesSearch && matchesFilter;
    });
    if (!visibleItems.length) {
            inventoryTable.innerHTML = `<tr><td colspan="6">${items.length ? "No stock matches this filter." : "No inventory items added yet."}</td></tr>`;
            return;
    }

    const batches = visibleItems.reduce((groups, item) => {
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
                    <td>${escapeHtml(item.quantity)} ${escapeHtml(item.unit)}</td>
                    <td>${formatInventoryDate(item.expires_on)}</td>
                    <td>${inventoryFlags(item).expiring ? '<span class="inventory-status status-orange">Expiring soon</span>' : inventoryFlags(item).low ? '<span class="inventory-status status-orange">Low stock</span>' : '<span class="inventory-status status-green">In stock</span>'}</td>
                    <td><button type="button" class="pickup-button" data-pickup-item="${item.id}">Request pickup</button> <button type="button" class="delete-batch-button delete-inventory" data-inventory-id="${item.id}">Delete</button></td>
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
                wasteType: document.querySelector("#wasteType").value,
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
    const button = inventoryForm.querySelector('button[type="submit"]');
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
        window.alert("Share this pickup OTP with the assigned driver only when the driver arrives to collect the batch.");
    }
});

document.querySelector("#simulate-sensor").addEventListener("click", () => {
    const temperature = 2 + Math.random() * 5;
    const humidity = 45 + Math.random() * 20;
    const safe = temperature <= 5 && humidity <= 65;
    document.querySelector("#storage-temperature").textContent = `${temperature.toFixed(1)}°C`;
    document.querySelector("#storage-humidity").textContent = `${Math.round(humidity)}%`;
    document.querySelector("#temperature-status").textContent = temperature <= 5 ? "Within cold-storage range" : "Check cooling";
    document.querySelector("#humidity-status").textContent = humidity <= 65 ? "Within target range" : "Ventilation needed";
    document.querySelector("#storage-health").textContent = safe
        ? "Storage health: Good. Cooling is operating within the target range."
        : "Storage health: Attention needed. Check the cooling or ventilation system.";
    document.querySelector("#storage-health").classList.toggle("storage-warning", !safe);
});

function updateMaterialImage(event) {
    const file = event.target.files[0];
    document.querySelector("#cv-result").textContent = file
        ? `${file.name} is ready for computer-vision analysis. Confirm the detected details before adding stock.`
        : "No material image selected.";
}

document.querySelector("#material-image").addEventListener("change", updateMaterialImage);
document.querySelector("#material-camera").addEventListener("change", updateMaterialImage);

document.querySelector("#inventory-search").addEventListener("input", (event) => {
    inventorySearch = event.target.value.trim().toLowerCase();
    renderInventory(window.producerInventory || []);
});

document.querySelectorAll("[data-inventory-filter]").forEach((button) => {
    button.addEventListener("click", () => {
        inventoryFilter = button.dataset.inventoryFilter;
        document.querySelectorAll("[data-inventory-filter]").forEach((filterButton) => {
            filterButton.classList.toggle("active", filterButton === button);
        });
        renderInventory(window.producerInventory || []);
    });
});

const cameraModal = document.querySelector("#camera-modal");
const materialVideo = document.querySelector("#material-video");
const materialCanvas = document.querySelector("#material-canvas");
const cameraStatus = document.querySelector("#camera-status");
let materialCameraStream = null;

function stopMaterialCamera() {
    if (materialCameraStream) {
        materialCameraStream.getTracks().forEach((track) => track.stop());
        materialCameraStream = null;
    }
    materialVideo.srcObject = null;
    cameraModal.hidden = true;
}

async function openMaterialCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
        cameraStatus.textContent = "Live camera is not supported here. Use device upload instead.";
        cameraStatus.style.color = "#b34c4c";
        cameraModal.hidden = false;
        return;
    }

    cameraModal.hidden = false;
    cameraStatus.textContent = "Requesting camera access...";
    cameraStatus.style.color = "";
    try {
        materialCameraStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: "environment" } },
            audio: false,
        });
        materialVideo.srcObject = materialCameraStream;
        await materialVideo.play();
        cameraStatus.textContent = "Position the material in the frame, then take the photo.";
    } catch (error) {
        stopMaterialCamera();
        cameraModal.hidden = false;
        cameraStatus.textContent = error.name === "NotAllowedError"
            ? "Camera permission was denied. Use device upload instead."
            : "Unable to start the camera. Use device upload instead.";
        cameraStatus.style.color = "#b34c4c";
    }
}

function captureMaterialPhoto() {
    if (!materialCameraStream || !materialVideo.videoWidth) {
        cameraStatus.textContent = "Camera is not ready yet.";
        cameraStatus.style.color = "#b34c4c";
        return;
    }

    materialCanvas.width = materialVideo.videoWidth;
    materialCanvas.height = materialVideo.videoHeight;
    materialCanvas.getContext("2d").drawImage(materialVideo, 0, 0);
    materialCanvas.toBlob((blob) => {
        if (!blob) {
            cameraStatus.textContent = "Unable to capture the photo. Please try again.";
            cameraStatus.style.color = "#b34c4c";
            return;
        }
        const file = new File([blob], `material-${Date.now()}.jpg`, { type: "image/jpeg" });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        document.querySelector("#material-image").files = transfer.files;
        updateMaterialImage({ target: { files: [file] } });
        stopMaterialCamera();
    }, "image/jpeg", 0.9);
}

document.querySelector("#open-camera").addEventListener("click", openMaterialCamera);
document.querySelector("#take-photo").addEventListener("click", captureMaterialPhoto);
document.querySelector("#close-camera").addEventListener("click", stopMaterialCamera);
document.querySelector("#use-camera-upload").addEventListener("click", () => {
    stopMaterialCamera();
    document.querySelector("#material-camera").click();
});
cameraModal.addEventListener("click", (event) => {
    if (event.target === cameraModal) stopMaterialCamera();
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
    const pickupButton = event.target.closest(".pickup-button");
    if (pickupButton) {
        const item = window.producerInventory.find((entry) => String(entry.id) === pickupButton.dataset.pickupItem);
        if (item) requestPickup(item);
        return;
    }
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
