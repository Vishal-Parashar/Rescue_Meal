import React, { useEffect, useState } from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client";
import {
  MapContainer,
  Marker,
  Polyline,
  Popup,
  TileLayer,
  useMap,
} from "https://esm.sh/react-leaflet@4.2.1?external=react,react-dom";
import L from "https://esm.sh/leaflet@1.9.4";

const fallbackSource = [20.5937, 78.9629];
const fallbackDestination = [20.6037, 78.9729];

function FitRoute({ points }) {
  const map = useMap();
  useEffect(() => {
    if (points.length > 1) map.fitBounds(points, { padding: [24, 24] });
  }, [map, points]);
  return null;
}

function RouteMap({ assignment }) {
  const source = [
    Number(assignment?.source_lat) || fallbackSource[0],
    Number(assignment?.source_lng) || fallbackSource[1],
  ];
  const destination = [
    Number(assignment?.destination_lat) || fallbackDestination[0],
    Number(assignment?.destination_lng) || fallbackDestination[1],
  ];
  const points = [source, destination];
  const marker = (color) => L.divIcon({
    className: "resqmeal-map-marker",
    html: `<span style="background:${color}"></span>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });

  return React.createElement(
    MapContainer,
    { center: source, zoom: 13, scrollWheelZoom: false, style: { height: "100%", minHeight: "18rem" } },
    React.createElement(TileLayer, {
      attribution: '&copy; OpenStreetMap contributors',
      url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    }),
    React.createElement(FitRoute, { points }),
    React.createElement(Polyline, { positions: points, color: "#397696", weight: 4 }),
    React.createElement(Marker, { position: source, icon: marker("#397696") },
      React.createElement(Popup, null, assignment?.producer_name || assignment?.producer_email || "Pickup source")),
    React.createElement(Marker, { position: destination, icon: marker("#2c8b61") },
      React.createElement(Popup, null, assignment?.assigned_shelter || "Delivery destination")),
  );
}

function DeliveryMap() {
  const [assignment, setAssignment] = useState(window.resqmealAssignments?.[0] || null);
  useEffect(() => {
    const update = (event) => setAssignment(event.detail?.[0] || null);
    window.addEventListener("resqmeal:assignments", update);
    return () => window.removeEventListener("resqmeal:assignments", update);
  }, []);
  return React.createElement(RouteMap, { assignment });
}

const container = document.querySelector("#live-map");
if (container) createRoot(container).render(React.createElement(DeliveryMap));
