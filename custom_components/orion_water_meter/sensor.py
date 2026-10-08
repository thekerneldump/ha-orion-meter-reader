"""Sensors for Orion Water Meter."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorEntityDescription,
    SensorStateClass,
)
from homeassistant.const import EntityCategory, UnitOfFrequency, UnitOfVolume
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.util.dt import parse_datetime

from . import OrionWaterMeterConfigEntry
from .api import OrionReading
from .entity import OrionWaterMeterEntity
from .history import async_backfill_history

PARALLEL_UPDATES = 0


def _number(packet: OrionReading, key: str) -> float | None:
    value = packet.get(key)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    return None


def _water_value(packet: OrionReading, key: str) -> float | None:
    converted = _number(packet, key)
    if converted is not None:
        return converted
    if key == "reading_gallons":
        reading = _number(packet, "reading")
        return None if reading is None else reading / 10
    if key == "usage_since_snapshot_gallons":
        reading = _number(packet, "reading")
        snapshot = _number(packet, "daily_reading")
        if reading is not None and snapshot is not None:
            return (reading - snapshot) / 10
    return None


def _timestamp(packet: OrionReading, key: str) -> datetime | None:
    value = packet.get(key)
    parsed = parse_datetime(value) if isinstance(value, str) else None
    if parsed is None or parsed.tzinfo is None:
        return None
    return parsed


def _center_frequency(packet: OrionReading, _: str) -> float | None:
    low = _number(packet, "freq1")
    high = _number(packet, "freq2")
    if low is None or high is None:
        return None
    return (low + high) / 2


@dataclass(frozen=True, kw_only=True)
class OrionSensorDescription(SensorEntityDescription):
    """Describe an Orion water meter sensor."""

    value_fn: Callable[[OrionReading, str], Any] = _number


SENSORS: tuple[OrionSensorDescription, ...] = (
    OrionSensorDescription(
        key="reading_gallons",
        translation_key="total_water",
        device_class=SensorDeviceClass.WATER,
        native_unit_of_measurement=UnitOfVolume.GALLONS,
        state_class=SensorStateClass.TOTAL_INCREASING,
        suggested_display_precision=1,
        value_fn=_water_value,
    ),
    OrionSensorDescription(
        key="usage_since_snapshot_gallons",
        translation_key="usage_since_snapshot",
        device_class=SensorDeviceClass.WATER,
        native_unit_of_measurement=UnitOfVolume.GALLONS,
        suggested_display_precision=1,
        value_fn=_water_value,
    ),
    OrionSensorDescription(
        key="interval_usage_gallons",
        translation_key="interval_usage",
        device_class=SensorDeviceClass.WATER,
        native_unit_of_measurement=UnitOfVolume.GALLONS,
        suggested_display_precision=1,
        value_fn=_water_value,
    ),
    OrionSensorDescription(
        key="ingested_at",
        translation_key="last_seen",
        device_class=SensorDeviceClass.TIMESTAMP,
        entity_category=EntityCategory.DIAGNOSTIC,
        value_fn=_timestamp,
    ),
    OrionSensorDescription(
        key="frequency",
        translation_key="frequency",
        device_class=SensorDeviceClass.FREQUENCY,
        native_unit_of_measurement=UnitOfFrequency.MEGAHERTZ,
        state_class=SensorStateClass.MEASUREMENT,
        entity_category=EntityCategory.DIAGNOSTIC,
        entity_registry_enabled_default=False,
        suggested_display_precision=3,
        value_fn=_center_frequency,
    ),
    OrionSensorDescription(
        key="rssi",
        translation_key="signal_strength",
        native_unit_of_measurement="dB",
        state_class=SensorStateClass.MEASUREMENT,
        entity_category=EntityCategory.DIAGNOSTIC,
        entity_registry_enabled_default=False,
        suggested_display_precision=1,
    ),
    OrionSensorDescription(
        key="snr",
        translation_key="signal_to_noise",
        native_unit_of_measurement="dB",
        state_class=SensorStateClass.MEASUREMENT,
        entity_category=EntityCategory.DIAGNOSTIC,
        entity_registry_enabled_default=False,
        suggested_display_precision=1,
    ),
    OrionSensorDescription(
        key="noise",
        translation_key="noise",
        native_unit_of_measurement="dB",
        state_class=SensorStateClass.MEASUREMENT,
        entity_category=EntityCategory.DIAGNOSTIC,
        entity_registry_enabled_default=False,
        suggested_display_precision=1,
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: OrionWaterMeterConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up sensors and discover meters added later."""
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
                OrionWaterMeterSensor(entry, meter_id, description)
                for meter_id in sorted(new_meter_ids)
                for description in SENSORS
            ]
        )

    _async_add_new_meters()
    entry.async_on_unload(coordinator.async_add_listener(_async_add_new_meters))


class OrionWaterMeterSensor(OrionWaterMeterEntity, SensorEntity):
    """A sensor sourced from one Orion endpoint."""

    entity_description: OrionSensorDescription

    def __init__(
        self,
        entry: OrionWaterMeterConfigEntry,
        meter_id: str,
        description: OrionSensorDescription,
    ) -> None:
        super().__init__(entry, meter_id, description.key)
        self._config_entry_id = entry.entry_id
        self.entity_description = description

    async def async_added_to_hass(self) -> None:
        """Start a safe historical backfill for the cumulative sensor."""
        await super().async_added_to_hass()
        if (
            self.entity_description.key == "reading_gallons"
            and self.entity_id is not None
        ):
            self.hass.async_create_background_task(
                async_backfill_history(
                    self.hass,
                    self.coordinator.api,
                    self._config_entry_id,
                    self._meter_id,
                    self.entity_id,
                ),
                "orion_water_meter historical backfill",
            )

    @property
    def native_value(self) -> Any:
        """Return the latest value."""
        return self.entity_description.value_fn(
            self.packet, self.entity_description.key
        )
