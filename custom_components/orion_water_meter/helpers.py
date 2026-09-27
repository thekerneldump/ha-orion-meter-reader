"""Pure helper functions for Orion Water Meter."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit, urlunsplit


def normalize_url(value: str) -> str:
    """Normalize and validate an Orion Water Meter base URL."""
    url = value.strip().rstrip("/")
    lower_url = url.lower()
    if "://" in url and not lower_url.startswith(("http://", "https://")):
        raise ValueError("Invalid scheme")
    if not lower_url.startswith(("http://", "https://")):
        url = f"http://{url}"

    try:
        parsed = urlsplit(url)
        port = parsed.port
        hostname = parsed.hostname
    except ValueError as err:
        raise ValueError("Invalid URL") from err

    if (
        parsed.scheme not in {"http", "https"}
        or not hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("Invalid URL")

    host = hostname.lower()
    if ":" in host:
        host = f"[{host}]"
    netloc = f"{host}:{port}" if port is not None else host
    path = parsed.path.rstrip("/")
    return urlunsplit((parsed.scheme.lower(), netloc, path, "", ""))


def _reading_gallons(reading: dict[str, Any] | None) -> float | None:
    """Return a packet's cumulative reading in gallons."""
    if not reading:
        return None
    converted = reading.get("reading_gallons")
    if isinstance(converted, (int, float)) and not isinstance(converted, bool):
        return float(converted)
    raw = reading.get("reading")
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        return float(raw) / 10
    return None


def add_interval_usage(
    readings: dict[str, dict[str, Any]],
    previous: dict[str, dict[str, Any]] | None,
) -> dict[str, dict[str, Any]]:
    """Add the latest usage delta while ignoring unchanged meter reports."""
    result: dict[str, dict[str, Any]] = {}
    previous = previous or {}

    for meter_id, reading in readings.items():
        packet = dict(reading)
        current_value = _reading_gallons(reading)
        previous_packet = previous.get(meter_id)
        previous_value = _reading_gallons(previous_packet)
        interval_usage = None
        if (
            current_value is not None
            and previous_value is not None
            and current_value >= previous_value
        ):
            if current_value == previous_value:
                retained = (previous_packet or {}).get("interval_usage_gallons")
                if isinstance(retained, (int, float)) and not isinstance(
                    retained, bool
                ):
                    interval_usage = float(retained)
            else:
                interval_usage = round(current_value - previous_value, 6)
        packet["interval_usage_gallons"] = interval_usage
        result[meter_id] = packet

    return result
