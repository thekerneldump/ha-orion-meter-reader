"""Config flow for Orion Water Meter."""

from __future__ import annotations

import logging
from typing import Any
from urllib.parse import urlsplit

import voluptuous as vol
from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import (
    OrionWaterMeterApi,
    OrionWaterMeterConnectionError,
    OrionWaterMeterInvalidResponse,
)
from .const import (
    CONF_SCAN_INTERVAL,
    CONF_URL,
    DEFAULT_SCAN_INTERVAL,
    DEFAULT_URL,
    DOMAIN,
    MAX_SCAN_INTERVAL,
    MIN_SCAN_INTERVAL,
)
from .helpers import normalize_url

_LOGGER = logging.getLogger(__name__)


def _schema(defaults: dict[str, Any]) -> vol.Schema:
    return vol.Schema(
        {
            vol.Required(
                CONF_URL,
                default=defaults.get(CONF_URL, DEFAULT_URL),
            ): str,
            vol.Required(
                CONF_SCAN_INTERVAL,
                default=defaults.get(CONF_SCAN_INTERVAL, DEFAULT_SCAN_INTERVAL),
            ): vol.All(
                vol.Coerce(int),
                vol.Range(min=MIN_SCAN_INTERVAL, max=MAX_SCAN_INTERVAL),
            ),
        }
    )


class OrionWaterMeterConfigFlow(ConfigFlow, domain=DOMAIN):
    """Set up an Orion Water Meter web interface."""

    VERSION = 1

    async def _async_validate(
        self, user_input: dict[str, Any]
    ) -> tuple[dict[str, Any] | None, str | None]:
        try:
            url = normalize_url(user_input[CONF_URL])
        except ValueError:
            return None, "invalid_url"

        api = OrionWaterMeterApi(async_get_clientsession(self.hass), url)
        try:
            await api.async_readings()
        except OrionWaterMeterConnectionError:
            return None, "cannot_connect"
        except OrionWaterMeterInvalidResponse:
            return None, "invalid_response"
        except Exception:
            _LOGGER.exception("Unexpected exception while validating connection")
            return None, "unknown"

        return {
            CONF_URL: url,
            CONF_SCAN_INTERVAL: user_input[CONF_SCAN_INTERVAL],
        }, None

    def _url_is_configured(self, url: str, exclude_entry_id: str | None = None) -> bool:
        for entry in self._async_current_entries():
            if entry.entry_id == exclude_entry_id:
                continue
            try:
                configured_url = normalize_url(entry.data[CONF_URL])
            except (KeyError, ValueError):
                continue
            if configured_url == url:
                return True
        return False

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Handle initial setup."""
        errors: dict[str, str] = {}

        if user_input is not None:
            data, error = await self._async_validate(user_input)
            if error is not None:
                errors["base"] = error
            else:
                assert data is not None
                if self._url_is_configured(data[CONF_URL]):
                    return self.async_abort(reason="already_configured")
                host = urlsplit(data[CONF_URL]).netloc
                return self.async_create_entry(
                    title=f"Orion Water Meter ({host})",
                    data=data,
                )

        return self.async_show_form(
            step_id="user",
            data_schema=_schema(user_input or {}),
            errors=errors,
        )

    async def async_step_reconfigure(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Update the web interface URL and polling interval."""
        entry = self._get_reconfigure_entry()
        errors: dict[str, str] = {}

        if user_input is not None:
            data, error = await self._async_validate(user_input)
            if error is not None:
                errors["base"] = error
            else:
                assert data is not None
                if self._url_is_configured(data[CONF_URL], entry.entry_id):
                    return self.async_abort(reason="already_configured")
                return self.async_update_reload_and_abort(
                    entry,
                    data_updates=data,
                )

        return self.async_show_form(
            step_id="reconfigure",
            data_schema=_schema(user_input or dict(entry.data)),
            errors=errors,
        )
