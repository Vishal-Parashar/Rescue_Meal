from __future__ import annotations

from datetime import datetime
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
