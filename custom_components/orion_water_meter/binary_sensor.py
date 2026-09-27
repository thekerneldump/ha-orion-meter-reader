"""Binary sensors for Orion Water Meter."""

from __future__ import annotations

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
    BinarySensorEntityDescription,
)
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import OrionWaterMeterConfigEntry
from .entity import OrionWaterMeterEntity

PARALLEL_UPDATES = 0

LEAK_DESCRIPTION = BinarySensorEntityDescription(
    key="leaking",
    translation_key="leak",
    device_class=BinarySensorDeviceClass.MOISTURE,
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: OrionWaterMeterConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up leak sensors and discover meters added later."""
    coordinator = entry.runtime_data.coordinator
    known_meter_ids: set[str] = set()

    @callback
    def _async_add_new_meters() -> None:
        new_meter_ids = set(coordinator.data) - known_meter_ids
        if not new_meter_ids:
            return
        known_meter_ids.update(new_meter_ids)
        async_add_entities(
            [
                OrionWaterMeterLeakSensor(entry, meter_id)
                for meter_id in sorted(new_meter_ids)
            ]
        )

    _async_add_new_meters()
    entry.async_on_unload(coordinator.async_add_listener(_async_add_new_meters))


class OrionWaterMeterLeakSensor(OrionWaterMeterEntity, BinarySensorEntity):
    """Leak state reported by an Orion endpoint."""

    entity_description = LEAK_DESCRIPTION

    def __init__(self, entry: OrionWaterMeterConfigEntry, meter_id: str) -> None:
        super().__init__(entry, meter_id, LEAK_DESCRIPTION.key)

    @property
    def is_on(self) -> bool | None:
        """Return true when the endpoint reports a leak."""
        value = self.packet.get(LEAK_DESCRIPTION.key)
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return value != 0
        return None
