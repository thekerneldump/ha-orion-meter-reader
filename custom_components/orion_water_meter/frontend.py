"""Register the Orion Water Meter dashboard frontend."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Final

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant

from .const import DOMAIN

FRONTEND_URL: Final = f"/{DOMAIN}/frontend/orion-water-meter.js"
FRONTEND_VERSION: Final = "0.0.9"
_REGISTRATION_TASK: Final = "frontend_registration_task"


async def _async_register_frontend(hass: HomeAssistant) -> None:
    """Register the static path and dashboard resource."""
    frontend_file = Path(__file__).parent / "frontend" / "orion-water-meter.js"
    await hass.http.async_register_static_paths(
        [StaticPathConfig(FRONTEND_URL, str(frontend_file), False)]
    )
    add_extra_js_url(hass, f"{FRONTEND_URL}?v={FRONTEND_VERSION}")


async def async_register_frontend(hass: HomeAssistant) -> None:
    """Serve and load the dashboard strategy once, including concurrent setups."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    task = domain_data.get(_REGISTRATION_TASK)
    if task is None:
        task = hass.async_create_task(
            _async_register_frontend(hass),
            f"{DOMAIN} frontend registration",
        )
        domain_data[_REGISTRATION_TASK] = task

    try:
        await task
    except Exception:
        if domain_data.get(_REGISTRATION_TASK) is task:
            domain_data.pop(_REGISTRATION_TASK)
        raise
