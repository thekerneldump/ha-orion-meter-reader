"""Import retained Orion packets into Home Assistant statistics."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
import logging

from homeassistant.components.recorder import (
    DOMAIN as RECORDER_DOMAIN,
    get_instance,
    statistics,
)
from homeassistant.components.recorder.models import (
    StatisticData,
    StatisticMeanType,
    StatisticMetaData,
)
from homeassistant.const import UnitOfVolume
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util
from homeassistant.util.unit_conversion import VolumeConverter

from .api import OrionWaterMeterApi, OrionWaterMeterError
from .const import DOMAIN
from .helpers import build_hourly_history

_LOGGER = logging.getLogger(__name__)

_STORAGE_KEY = f"{DOMAIN}.history_backfill"
_STORAGE_VERSION = 1
_LOCK_KEY = "history_backfill_lock"


def _backfill_lock(hass: HomeAssistant) -> asyncio.Lock:
    """Return the integration-wide backfill storage lock."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    lock = domain_data.get(_LOCK_KEY)
    if not isinstance(lock, asyncio.Lock):
        lock = asyncio.Lock()
        domain_data[_LOCK_KEY] = lock
    return lock


async def _async_is_complete(hass: HomeAssistant, key: str) -> bool:
    """Return whether this meter's one-time backfill already completed."""
    async with _backfill_lock(hass):
        stored = await Store[dict[str, list[str]]](
            hass, _STORAGE_VERSION, _STORAGE_KEY
        ).async_load()
        completed = stored.get("completed", []) if stored else []
        return key in completed


async def _async_mark_complete(hass: HomeAssistant, key: str) -> None:
    """Persist completion so future integration reloads skip the backfill."""
    async with _backfill_lock(hass):
        store = Store[dict[str, list[str]]](hass, _STORAGE_VERSION, _STORAGE_KEY)
        stored = await store.async_load() or {}
        completed = set(stored.get("completed", []))
        completed.add(key)
        await store.async_save({"completed": sorted(completed)})


async def async_backfill_history(
    hass: HomeAssistant,
    api: OrionWaterMeterApi,
    entry_id: str,
    meter_id: str,
    entity_id: str,
) -> None:
    """Backfill hours preceding existing statistics once per meter."""
    backfill_key = f"{entry_id}:{meter_id}"
    if await _async_is_complete(hass, backfill_key):
        return

    try:
        packets = await api.async_history(meter_id)
    except OrionWaterMeterError as err:
        _LOGGER.debug("Historical packet backfill is unavailable: %s", err)
        return

    now = datetime.now(UTC)
    current_hour = now.replace(minute=0, second=0, microsecond=0)
    provisional = build_hourly_history(packets, current_hour, 0.0)
    if not provisional:
        return

    recorder = get_instance(hass)
    if not await recorder.async_db_ready:
        return

    try:
        existing = await recorder.async_add_executor_job(
            statistics.statistics_during_period,
            hass,
            provisional[0]["start"],
            None,
            {entity_id},
            "hour",
            None,
            {"sum"},
        )
    except (HomeAssistantError, KeyError, RuntimeError, ValueError) as err:
        _LOGGER.debug("Could not inspect existing water statistics: %s", err)
        return

    rows = existing.get(entity_id, [])
    cutoff = current_hour
    ending_sum = 0.0
    if rows:
        first = min(rows, key=lambda row: float(row["start"]))
        cutoff = dt_util.utc_from_timestamp(float(first["start"]))
        if isinstance(first.get("sum"), (int, float)):
            ending_sum = float(first["sum"])

    imported = build_hourly_history(packets, cutoff, ending_sum)
    if not imported:
        return

    metadata = StatisticMetaData(
        mean_type=StatisticMeanType.NONE,
        has_sum=True,
        name=None,
        source=RECORDER_DOMAIN,
        statistic_id=entity_id,
        unit_class=VolumeConverter.UNIT_CLASS,
        unit_of_measurement=UnitOfVolume.GALLONS,
    )
    try:
        statistics.async_import_statistics(
            hass,
            metadata,
            [StatisticData(**item) for item in imported],
        )
    except HomeAssistantError as err:
        _LOGGER.debug("Could not import retained water statistics: %s", err)
        return
    await _async_mark_complete(hass, backfill_key)
    _LOGGER.info(
        "Imported %d retained hourly water statistics",
        len(imported),
    )
