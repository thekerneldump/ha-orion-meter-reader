"""Tests for dashboard frontend registration."""

from __future__ import annotations

import asyncio
import importlib.util
import sys
import unittest
from pathlib import Path
from types import ModuleType

COMPONENT = Path(__file__).parents[1] / "custom_components" / "orion_water_meter"


class StaticPathConfig:
    """Minimal Home Assistant StaticPathConfig stand-in."""

    def __init__(self, url_path: str, path: str, cache_headers: bool) -> None:
        self.url_path = url_path
        self.path = path
        self.cache_headers = cache_headers


def _load_frontend_module():
    registered_urls: list[str] = []

    homeassistant = ModuleType("homeassistant")
    components = ModuleType("homeassistant.components")
    frontend_component = ModuleType("homeassistant.components.frontend")
    http_component = ModuleType("homeassistant.components.http")
    const_component = ModuleType("homeassistant.const")
    core = ModuleType("homeassistant.core")

    frontend_component.add_extra_js_url = (
        lambda _hass, url: registered_urls.append(url)
    )
    http_component.StaticPathConfig = StaticPathConfig
    const_component.Platform = type(
        "Platform",
        (),
        {"SENSOR": "sensor", "BINARY_SENSOR": "binary_sensor"},
    )
    core.HomeAssistant = object

    sys.modules["homeassistant"] = homeassistant
    sys.modules["homeassistant.components"] = components
    sys.modules["homeassistant.components.frontend"] = frontend_component
    sys.modules["homeassistant.components.http"] = http_component
    sys.modules["homeassistant.const"] = const_component
    sys.modules["homeassistant.core"] = core

    package_name = "orion_water_meter_frontend_test"
    package = ModuleType(package_name)
    package.__path__ = [str(COMPONENT)]
    sys.modules[package_name] = package

    const_spec = importlib.util.spec_from_file_location(
        f"{package_name}.const", COMPONENT / "const.py"
    )
    assert const_spec is not None and const_spec.loader is not None
    const_module = importlib.util.module_from_spec(const_spec)
    sys.modules[const_spec.name] = const_module
    const_spec.loader.exec_module(const_module)

    frontend_spec = importlib.util.spec_from_file_location(
        f"{package_name}.frontend", COMPONENT / "frontend.py"
    )
    assert frontend_spec is not None and frontend_spec.loader is not None
    frontend_module = importlib.util.module_from_spec(frontend_spec)
    sys.modules[frontend_spec.name] = frontend_module
    frontend_spec.loader.exec_module(frontend_module)
    return frontend_module, registered_urls


frontend, registered_urls = _load_frontend_module()


class FakeHttp:
    """Block registration so two config entries can overlap."""

    def __init__(self) -> None:
        self.calls = 0
        self.configs = []
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def async_register_static_paths(self, configs) -> None:
        self.calls += 1
        self.configs = configs
        self.started.set()
        await self.release.wait()


class FakeHass:
    def __init__(self) -> None:
        self.data = {}
        self.http = FakeHttp()

    def async_create_task(self, coro, name):
        return asyncio.create_task(coro, name=name)


class FrontendRegistrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_concurrent_entries_register_frontend_once(self):
        hass = FakeHass()

        first = asyncio.create_task(frontend.async_register_frontend(hass))
        await hass.http.started.wait()
        second = asyncio.create_task(frontend.async_register_frontend(hass))
        hass.http.release.set()
        await asyncio.gather(first, second)

        self.assertEqual(hass.http.calls, 1)
        self.assertEqual(len(registered_urls), 1)
        self.assertEqual(len(hass.http.configs), 2)


if __name__ == "__main__":
    unittest.main()
