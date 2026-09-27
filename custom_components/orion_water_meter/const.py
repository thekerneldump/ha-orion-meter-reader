"""Constants for the Orion Water Meter integration."""

from typing import Final

from homeassistant.const import Platform

DOMAIN: Final = "orion_water_meter"

CONF_URL: Final = "url"
CONF_SCAN_INTERVAL: Final = "scan_interval"

DEFAULT_URL: Final = "http://orion-reader.local:8083"
DEFAULT_SCAN_INTERVAL: Final = 15
MIN_SCAN_INTERVAL: Final = 5
MAX_SCAN_INTERVAL: Final = 3600

PLATFORMS: Final = (Platform.SENSOR, Platform.BINARY_SENSOR)
