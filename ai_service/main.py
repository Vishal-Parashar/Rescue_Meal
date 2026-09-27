from __future__ import annotations

from datetime import datetime
from math import asin, cos, radians, sin, sqrt
from typing import Any

from catboost import CatBoostClassifier
from fastapi import FastAPI
from lightgbm import LGBMRegressor
from pydantic import BaseModel, Field

app = FastAPI(title="ResQmeal AI service")


class ForecastRequest(BaseModel):
    batches: list[dict[str, Any]] = Field(default_factory=list)
    requirements: list[dict[str, Any]] = Field(default_factory=list)


class MatchRequest(BaseModel):
    listings: list[dict[str, Any]] = Field(default_factory=list)
    requirements: list[dict[str, Any]] = Field(default_factory=list)


class NgoAssignmentRequest(BaseModel):
    batch: dict[str, Any] = Field(default_factory=dict)
    requirements: list[dict[str, Any]] = Field(default_factory=list)


class RouteRequest(BaseModel):
    stops: list[dict[str, Any]] = Field(default_factory=list)


class QualityRequest(BaseModel):
    file_name: str = ""
    notes: str = ""


def numeric(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def days_old(value: Any) -> float:
    try:
        return max(0.0, (datetime.now() - datetime.fromisoformat(str(value).replace("Z", "+00:00")).replace(tzinfo=None)).total_seconds() / 86400)
    except (TypeError, ValueError):
        return 7.0


def days_until(value: Any) -> float:
    try:
        return (datetime.fromisoformat(str(value).replace("Z", "+00:00")).replace(tzinfo=None) - datetime.now()).total_seconds() / 86400
    except (TypeError, ValueError):
        return 999.0


def normalized_category(value: Any) -> str:
    category = str(value or "").strip().lower().replace("-", " ")
    aliases = {
        "cooked hot": "cooked", "cooked cold": "cooked", "cooked meal": "cooked",
        "bakery products": "bakery", "fresh produce": "fresh", "packaged food": "packaged",
        "drinking water": "water",
    }
    return aliases.get(category, category)


def distance_km(first_lat: Any, first_lng: Any, second_lat: Any, second_lng: Any) -> float | None:
    values = [numeric(first_lat, float("nan")), numeric(first_lng, float("nan")),
              numeric(second_lat, float("nan")), numeric(second_lng, float("nan"))]
    if any(not (-180 <= value <= 180) for value in values) or any(value != value for value in values):
        return None
    latitude_one, longitude_one, latitude_two, longitude_two = values
    if not (-90 <= latitude_one <= 90 and -90 <= latitude_two <= 90):
        return None
    delta_latitude = radians(latitude_two - latitude_one)
    delta_longitude = radians(longitude_two - longitude_one)
    haversine = sin(delta_latitude / 2) ** 2 + cos(radians(latitude_one)) * cos(radians(latitude_two)) * sin(delta_longitude / 2) ** 2
    return 6371 * 2 * asin(sqrt(haversine))


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "models": "lightgbm,catboost"}


@app.post("/forecast")
def forecast(payload: ForecastRequest) -> dict[str, Any]:
    batches = payload.batches
    requirements = payload.requirements
    if len(batches) < 3:
        return {"available": True, "cold_start": True, "outlook": "Insufficient data", "forecastServings": 0, "confidence": "Low", "recommendation": "Collect at least three producer submissions before using the trained forecast."}

    features = [[days_old(batch.get("created_at")), numeric(batch.get("quantity_value"))] for batch in batches]
    targets = [numeric(batch.get("quantity_value")) for batch in batches]
    model = LGBMRegressor(n_estimators=40, learning_rate=0.05, verbosity=-1)
    model.fit(features, targets)
    forecast_servings = max(0, round(float(model.predict([[0.0, sum(targets) / len(targets)]])[0])))
    demand = round(sum(numeric(item.get("servings")) for item in requirements))
    difference = forecast_servings - demand
    outlook = "Surplus" if difference > 0 else "Shortfall" if difference < 0 else "Balanced"
    return {
        "available": True,
        "cold_start": False,
        "outlook": outlook,
        "forecastServings": forecast_servings,
        "confidence": "Medium" if len(batches) < 10 else "High",
        "recommendation": f"Projected supply is {abs(difference)} servings {'above' if difference > 0 else 'below' if difference < 0 else 'aligned with'} open demand.",
    }


@app.post("/match")
def match(payload: MatchRequest) -> dict[str, Any]:
    if not payload.listings or not payload.requirements:
        return {"available": True, "cold_start": True, "summary": "Add available surplus and an open requirement to generate a recommendation.", "matches": []}

    rows: list[list[float]] = []
    labels: list[int] = []
    for listing in payload.listings:
        for index, requirement in enumerate(payload.requirements):
            category_match = int(str(listing.get("food_category", "")).lower() == str(requirement.get("food_category", "")).lower())
            quantity_gap = abs(numeric(listing.get("quantity_value")) - numeric(requirement.get("servings")))
            rows.append([category_match, quantity_gap, numeric(listing.get("quantity_value"))])
            labels.append(1 if category_match and quantity_gap <= max(numeric(requirement.get("servings")), 1) else 0)
    if len(set(labels)) < 2:
        return {"available": True, "cold_start": True, "summary": "The current data has no contrasting matches for a trained recommendation.", "matches": []}

    model = CatBoostClassifier(iterations=30, depth=4, verbose=False, allow_writing_files=False)
    model.fit(rows, labels)
    matches = []
    offset = 0
    for listing in payload.listings:
        for index, requirement in enumerate(payload.requirements):
            probability = float(model.predict_proba([rows[offset]])[0][1])
            offset += 1
            if probability >= 0.5:
                matches.append({"batchId": listing.get("id"), "requirementIndex": index, "priority": "High" if probability >= 0.8 else "Medium", "reason": f"{round(probability * 100)}% compatibility based on category and serving quantity."})
    matches.sort(key=lambda item: {"High": 0, "Medium": 1}.get(item["priority"], 2))
    return {"available": True, "cold_start": False, "summary": f"Found {len(matches)} compatible surplus-to-requirement matches.", "matches": matches[:5]}


@app.post("/assign-ngo")
def assign_ngo(payload: NgoAssignmentRequest) -> dict[str, Any]:
    batch = payload.batch
    batch_category = normalized_category(batch.get("food_category"))
    batch_quantity = numeric(batch.get("quantity_value"))
    candidates = []
    for requirement in payload.requirements:
        if normalized_category(requirement.get("food_category")) != batch_category:
            continue
        servings = numeric(requirement.get("servings"))
        if servings <= 0 or servings > batch_quantity:
            continue
        distance = distance_km(
            batch.get("source_latitude"), batch.get("source_longitude"),
            requirement.get("ngo_latitude"), requirement.get("ngo_longitude"),
        )
        hours_until_needed = numeric(requirement.get("hours_until_needed"), 168)
        urgency = max(0.0, min(1.0, 1 - (hours_until_needed / 168)))
        capacity_fit = min(servings / max(batch_quantity, 1), 1)
        distance_score = 0.0 if distance is None else max(0.0, 1 - min(distance, 100) / 100)
        score = (distance_score * 0.55) + (capacity_fit * 0.25) + (urgency * 0.20)
        candidates.append({
            "requirementId": requirement.get("id"),
            "ngoId": requirement.get("ngo_id"),
            "distanceKm": None if distance is None else round(distance, 2),
            "score": round(score, 4),
            "reason": "Category and serving capacity match; ranked by distance, urgency, and capacity fit.",
        })
    candidates.sort(key=lambda item: (-item["score"], item["distanceKm"] is None, item["distanceKm"] or float("inf")))
    return {
        "available": True,
        "assigned": bool(candidates),
        "match": candidates[0] if candidates else None,
        "candidates": candidates[:5],
    }


@app.post("/expiry-risk")
def expiry_risk(payload: ForecastRequest) -> dict[str, Any]:
    alerts = []
    for item in payload.batches:
        days = days_until(item.get("expires_on"))
        if days <= 3:
            alerts.append({"id": item.get("id"), "item": item.get("item_name", item.get("food_description", "stock")),
                           "daysUntilExpiry": round(days, 1), "severity": "critical" if days <= 0 else "high"})
    return {"available": True, "alerts": alerts}


@app.post("/route-plan")
def route_plan(payload: RouteRequest) -> dict[str, Any]:
    stops = payload.stops
    ordered = sorted(stops, key=lambda stop: 0 if stop.get("type") == "pickup" else 1)
    distance = 0.0
    for first, second in zip(ordered, ordered[1:]):
        segment = distance_km(first.get("latitude"), first.get("longitude"),
                             second.get("latitude"), second.get("longitude"))
        if segment is not None:
            distance += segment
    return {"available": True, "provider": "simulated", "stops": ordered,
            "distanceKm": round(distance, 2), "durationMinutes": round(distance * 3 + len(ordered) * 8)}


@app.post("/quality-check")
def quality_check(payload: QualityRequest) -> dict[str, Any]:
    # Explicit metadata-only fallback until a vision model is configured.
    return {"available": True, "provider": "simulated", "qualityScore": 85,
            "detectedLabels": ["food-label", "traceability-ready"],
            "summary": f"Metadata recorded for {payload.file_name or 'uploaded image'}."}
