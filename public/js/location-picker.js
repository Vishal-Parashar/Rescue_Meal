(() => {
  const modal = document.querySelector("#location-picker-modal");
  const openButton = document.querySelector("#choose-map-location");
  const closeButton = document.querySelector("#location-picker-close");
  const confirmButton = document.querySelector("#confirm-map-location");
  const mapElement = document.querySelector("#location-map");
  if (!modal || !openButton || !closeButton || !confirmButton || !mapElement) return;

  let map;
  let marker;
  let selectedPoint;
  const fallback = [20.5937, 78.9629];

  const closeMap = () => { modal.hidden = true; };
  const setMarker = (latitude, longitude) => {
    selectedPoint = { latitude, longitude };
    if (marker) marker.setLatLng([latitude, longitude]);
    else marker = window.L.marker([latitude, longitude]).addTo(map);
  };

  openButton.addEventListener("click", () => {
    if (!window.L) {
      document.querySelector("#location-status").textContent = "The map is still loading. Please try again.";
      return;
    }
    const latitude = Number(document.querySelector("#profile-latitude").value);
    const longitude = Number(document.querySelector("#profile-longitude").value);
    const hasSavedLocation = Number.isFinite(latitude) && Number.isFinite(longitude);
    const center = hasSavedLocation ? [latitude, longitude] : fallback;
    modal.hidden = false;
    if (!map) {
      map = window.L.map(mapElement).setView(center, hasSavedLocation ? 15 : 5);
      window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors",
        maxZoom: 19,
      }).addTo(map);
      map.on("click", (event) => setMarker(event.latlng.lat, event.latlng.lng));
    } else {
      map.setView(center, hasSavedLocation ? 15 : 5);
    }
    if (hasSavedLocation) setMarker(latitude, longitude);
    window.setTimeout(() => map.invalidateSize(), 0);
  });

  confirmButton.addEventListener("click", () => {
    if (!selectedPoint) {
      document.querySelector("#location-status").textContent = "Click the map to place your location pin first.";
      return;
    }
    document.querySelector("#profile-latitude").value = selectedPoint.latitude.toFixed(6);
    document.querySelector("#profile-longitude").value = selectedPoint.longitude.toFixed(6);
    document.querySelector("#location-status").textContent = "Map location selected. Save your profile to use it for routing.";
    closeMap();
  });

  closeButton.addEventListener("click", closeMap);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeMap();
  });
})();
