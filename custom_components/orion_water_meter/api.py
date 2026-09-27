"""HTTP client for the Orion Water Meter web interface."""

from __future__ import annotations

import asyncio
from typing import Any

from aiohttp import ClientError, ClientSession

type OrionReading = dict[str, Any]
type OrionReadings = dict[str, OrionReading]


class OrionWaterMeterError(Exception):
    """Base API error."""


class OrionWaterMeterConnectionError(OrionWaterMeterError):
    """The web interface could not be reached."""


class OrionWaterMeterInvalidResponse(OrionWaterMeterError):
    """The web interface returned an unexpected response."""


class OrionWaterMeterApi:
    """Asynchronous client for the meter reader API."""

    def __init__(self, session: ClientSession, base_url: str) -> None:
        self._session = session
        self.base_url = base_url.rstrip("/")

    async def async_readings(self) -> OrionReadings:
        """Return the latest reading for every known endpoint."""
        try:
            async with asyncio.timeout(10):
                async with self._session.get(
                    f"{self.base_url}/api/readings"
                ) as response:
                    response.raise_for_status()
                    payload = await response.json(content_type=None)
        except (TimeoutError, ClientError) as err:
            raise OrionWaterMeterConnectionError from err
        except ValueError as err:
            raise OrionWaterMeterInvalidResponse from err

        if not isinstance(payload, dict):
            raise OrionWaterMeterInvalidResponse("Expected a JSON object")

        readings: OrionReadings = {}
        for meter_id, reading in payload.items():
            if not isinstance(reading, dict):
                raise OrionWaterMeterInvalidResponse(
                    "A meter reading is not a JSON object"
                )
            readings[str(meter_id)] = reading
        return readings
