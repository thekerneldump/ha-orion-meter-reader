"""Register the Orion Water Meter dashboard frontend."""

from __future__ import annotations

from pathlib import Path
from typing import Final

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant

from .const import DOMAIN

FRONTEND_URL: Final = f"/{DOMAIN}/frontend/orion-water-meter.js"
FRONTEND_VERSION: Final = "0.0.7"
_REGISTERED: Final = "frontend_registered"


async def async_register_frontend(hass: HomeAssistant) -> None:
    """Serve and load the dashboard strategy once per Home Assistant process."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    if domain_data.get(_REGISTERED):
        return

    frontend_file = Path(__file__).parent / "frontend" / "orion-water-meter.js"
    await hass.http.async_register_static_paths(
        [StaticPathConfig(FRONTEND_URL, str(frontend_file), False)]
    )
    add_extra_js_url(hass, f"{FRONTEND_URL}?v={FRONTEND_VERSION}")
    domain_data[_REGISTERED] = True
