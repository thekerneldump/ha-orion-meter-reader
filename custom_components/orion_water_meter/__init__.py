"""Orion Water Meter integration."""

from __future__ import annotations

from dataclasses import dataclass

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import OrionWaterMeterApi
from .const import (
    CONF_SCAN_INTERVAL,
    CONF_URL,
    DEFAULT_SCAN_INTERVAL,
    DOMAIN,
    PLATFORMS,
)
from .coordinator import OrionWaterMeterCoordinator


@dataclass
class OrionWaterMeterData:
    """Runtime data for one config entry."""

    coordinator: OrionWaterMeterCoordinator
    hub_device_id: str


type OrionWaterMeterConfigEntry = ConfigEntry[OrionWaterMeterData]


async def async_setup_entry(
    hass: HomeAssistant, entry: OrionWaterMeterConfigEntry
) -> bool:
    """Set up Orion Water Meter from a config entry."""
    api = OrionWaterMeterApi(async_get_clientsession(hass), entry.data[CONF_URL])
    coordinator = OrionWaterMeterCoordinator(
        hass,
        entry,
        api,
        entry.data.get(CONF_SCAN_INTERVAL, DEFAULT_SCAN_INTERVAL),
    )
    await coordinator.async_config_entry_first_refresh()

    hub_device = dr.async_get(hass).async_get_or_create(
        config_entry_id=entry.entry_id,
        identifiers={(DOMAIN, entry.entry_id)},
        name="Orion Water Meter",
        model="Web interface",
        entry_type=dr.DeviceEntryType.SERVICE,
        configuration_url=entry.data[CONF_URL],
    )
    entry.runtime_data = OrionWaterMeterData(coordinator, hub_device.id)

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(
    hass: HomeAssistant, entry: OrionWaterMeterConfigEntry
) -> bool:
    """Unload an Orion Water Meter config entry."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
