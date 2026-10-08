"""HTTP client for the Orion Water Meter web interface."""

from __future__ import annotations

import asyncio
import json
import re
import time
from typing import Any
from urllib.parse import quote

from aiohttp import ClientError, ClientSession

type OrionReading = dict[str, Any]
type OrionReadings = dict[str, OrionReading]

HISTORY_CACHE_SECONDS = 300
MAX_HISTORY_BYTES = 25 * 1024 * 1024
HISTORY_FILE_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$")


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
        self._history_cache: dict[
            str, tuple[float, dict[str, list[OrionReading]]]
        ] = {}
        self._history_lock = asyncio.Lock()

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

    async def async_history(
        self,
        meter_id: str,
        filename: str = "neighbor-discovery.jsonl",
    ) -> list[OrionReading]:
        """Return retained packets for one endpoint from a reader JSONL file."""
        if not HISTORY_FILE_PATTERN.fullmatch(filename):
            raise OrionWaterMeterInvalidResponse("Invalid history filename")

        async with self._history_lock:
            cached = self._history_cache.get(filename)
            if (
                cached is None
                or time.monotonic() - cached[0] >= HISTORY_CACHE_SECONDS
            ):
                history = await self._async_load_history(filename)
                cached = (time.monotonic(), history)
                self._history_cache[filename] = cached
        return list(cached[1].get(str(meter_id), ()))

    async def _async_load_history(
        self,
        filename: str,
    ) -> dict[str, list[OrionReading]]:
        """Download and parse one bounded reader JSONL history file."""
        try:
            async with asyncio.timeout(30):
                async with self._session.get(
                    f"{self.base_url}/files/{quote(filename, safe='')}"
                ) as response:
                    response.raise_for_status()
                    content_length = response.content_length
                    if (
                        content_length is not None
                        and content_length > MAX_HISTORY_BYTES
                    ):
                        raise OrionWaterMeterInvalidResponse(
                            "History file is too large"
                        )
                    body = await response.text()
        except OrionWaterMeterInvalidResponse:
            raise
        except (TimeoutError, ClientError) as err:
            raise OrionWaterMeterConnectionError from err
        except UnicodeError as err:
            raise OrionWaterMeterInvalidResponse(
                "History file is not valid UTF-8"
            ) from err

        if len(body.encode("utf-8")) > MAX_HISTORY_BYTES:
            raise OrionWaterMeterInvalidResponse("History file is too large")

        history: dict[str, list[OrionReading]] = {}
        try:
            for line in body.splitlines():
                if not line.strip():
                    continue
                packet = json.loads(line)
                if (
                    not isinstance(packet, dict)
                    or packet.get("protocol") != 290
                    or packet.get("id") is None
                ):
                    continue
                history.setdefault(str(packet["id"]), []).append(packet)
        except (UnicodeError, ValueError) as err:
            raise OrionWaterMeterInvalidResponse(
                "History file contains invalid JSONL"
            ) from err
        return history
