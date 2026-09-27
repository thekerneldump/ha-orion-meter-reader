"""Shared Orion water meter entity."""

from __future__ import annotations

from typing import Any

from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from . import OrionWaterMeterConfigEntry
from .const import DOMAIN
from .coordinator import OrionWaterMeterCoordinator


class OrionWaterMeterEntity(CoordinatorEntity[OrionWaterMeterCoordinator]):
    """Base entity tied to one Orion endpoint."""

    _attr_has_entity_name = True

    def __init__(
        self,
        entry: OrionWaterMeterConfigEntry,
        meter_id: str,
        key: str,
    ) -> None:
        data = entry.runtime_data
        super().__init__(data.coordinator)
        self._meter_id = meter_id
        self._attr_unique_id = f"{entry.entry_id}_{meter_id}_{key}"

        packet = self.packet
        model = packet.get("model") or "Orion Endpoint"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, meter_id)},
            name=f"Orion meter {meter_id}",
            manufacturer="Badger Meter",
            model=str(model),
            via_device_id=data.hub_device_id,
        )

    @property
    def packet(self) -> dict[str, Any]:
        """Return this meter's latest packet."""
        return self.coordinator.data.get(self._meter_id, {})

    @property
    def available(self) -> bool:
        """Report whether the API and meter data are available."""
        return super().available and self._meter_id in self.coordinator.data
