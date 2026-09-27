"""Data coordinator for Orion Water Meter."""

from __future__ import annotations

import logging
from datetime import timedelta

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import OrionReadings, OrionWaterMeterApi, OrionWaterMeterError
from .const import DOMAIN
from .helpers import add_interval_usage

_LOGGER = logging.getLogger(__name__)


class OrionWaterMeterCoordinator(DataUpdateCoordinator[OrionReadings]):
    """Poll an Orion Water Meter web interface."""

    def __init__(
        self,
        hass: HomeAssistant,
        entry: ConfigEntry,
        api: OrionWaterMeterApi,
        scan_interval: int,
    ) -> None:
        super().__init__(
            hass,
            logger=_LOGGER,
            config_entry=entry,
            name=DOMAIN,
            update_interval=timedelta(seconds=scan_interval),
            always_update=False,
        )
        self.api = api

    async def _async_update_data(self) -> OrionReadings:
        try:
            readings = await self.api.async_readings()
        except OrionWaterMeterError as err:
            raise UpdateFailed(f"Unable to fetch readings: {err}") from err
        return add_interval_usage(readings, self.data)
