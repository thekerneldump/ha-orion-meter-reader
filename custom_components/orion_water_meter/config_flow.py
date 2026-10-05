"""Config flow for Orion Water Meter."""

from __future__ import annotations

import logging
from typing import Any
from urllib.parse import urlsplit

import voluptuous as vol
from homeassistant.config_entries import ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.core import callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.selector import (
    SelectOptionDict,
    SelectSelector,
    SelectSelectorConfig,
    TextSelector,
)

from .api import (
    OrionWaterMeterApi,
    OrionWaterMeterConnectionError,
    OrionWaterMeterInvalidResponse,
)
from .const import (
    CONF_FRIENDLY_NAME,
    CONF_METER_ID,
    CONF_METER_NAMES,
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

    @staticmethod
    @callback
    def async_get_options_flow(
        _config_entry: Any,
    ) -> OrionWaterMeterOptionsFlow:
        """Return the options flow for meter friendly names."""
        return OrionWaterMeterOptionsFlow()

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


class OrionWaterMeterOptionsFlow(OptionsFlow):
    """Configure friendly names for discovered meters."""

    def __init__(self) -> None:
        self._meter_id: str | None = None

    def _meter_names(self) -> dict[str, str]:
        configured = self.config_entry.options.get(CONF_METER_NAMES, {})
        if not isinstance(configured, dict):
            return {}
        return {
            str(meter_id): str(name)
            for meter_id, name in configured.items()
            if isinstance(name, str) and name.strip()
        }

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Choose the discovered meter to name."""
        meter_ids = sorted(self.config_entry.runtime_data.coordinator.data)
        if not meter_ids:
            return self.async_abort(reason="no_meters")

        if user_input is not None:
            self._meter_id = user_input[CONF_METER_ID]
            return await self.async_step_meter()

        names = self._meter_names()
        options = [
            SelectOptionDict(
                value=meter_id,
                label=names.get(meter_id, f"Orion meter {meter_id}"),
            )
            for meter_id in meter_ids
        ]
        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_METER_ID): SelectSelector(
                        SelectSelectorConfig(options=options)
                    )
                }
            ),
        )

    async def async_step_meter(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Set or clear the selected meter's friendly name."""
        if self._meter_id is None:
            return await self.async_step_init()

        names = self._meter_names()
        if user_input is not None:
            friendly_name = user_input.get(CONF_FRIENDLY_NAME, "").strip()
            if friendly_name:
                names[self._meter_id] = friendly_name
            else:
                names.pop(self._meter_id, None)

            options = dict(self.config_entry.options)
            options[CONF_METER_NAMES] = names
            return self.async_create_entry(title="", data=options)

        return self.async_show_form(
            step_id="meter",
            data_schema=vol.Schema(
                {
                    vol.Optional(
                        CONF_FRIENDLY_NAME,
                        default=names.get(self._meter_id, ""),
                    ): TextSelector()
                }
            ),
            description_placeholders={"meter_id": self._meter_id},
        )
