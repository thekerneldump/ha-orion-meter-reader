"""Tests for pure Orion Water Meter modules."""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path
from types import ModuleType


class ClientError(Exception):
    """Stub aiohttp client error."""


aiohttp = ModuleType("aiohttp")
aiohttp.ClientError = ClientError
aiohttp.ClientSession = object
sys.modules.setdefault("aiohttp", aiohttp)

COMPONENT = Path(__file__).parents[1] / "custom_components" / "orion_water_meter"


def _load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, COMPONENT / filename)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


api = _load_module("orion_water_meter_api", "api.py")
helpers = _load_module("orion_water_meter_helpers", "helpers.py")


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    def raise_for_status(self):
        return None

    async def json(self, **_kwargs):
        return self.payload


class FakeSession:
    def __init__(self, payload):
        self.payload = payload
        self.requested_url = None

    def get(self, url):
        self.requested_url = url
        return FakeResponse(self.payload)


class ApiTests(unittest.IsolatedAsyncioTestCase):
    async def test_reads_endpoint_mapping(self):
        session = FakeSession({"example-meter": {"id": 42, "reading": 100}})
        client = api.OrionWaterMeterApi(session, "http://reader:8083/")

        readings = await client.async_readings()

        self.assertEqual(readings["example-meter"]["reading"], 100)
        self.assertEqual(session.requested_url, "http://reader:8083/api/readings")

    async def test_rejects_non_mapping_response(self):
        client = api.OrionWaterMeterApi(FakeSession([]), "http://reader:8083")

        with self.assertRaises(api.OrionWaterMeterInvalidResponse):
            await client.async_readings()

    async def test_rejects_non_mapping_reading(self):
        client = api.OrionWaterMeterApi(
            FakeSession({"example-meter": "invalid"}), "http://reader:8083"
        )

        with self.assertRaises(api.OrionWaterMeterInvalidResponse):
            await client.async_readings()


class UrlTests(unittest.TestCase):
    def test_adds_default_scheme(self):
        self.assertEqual(
            helpers.normalize_url("reader.local:8083/"),
            "http://reader.local:8083",
        )

    def test_preserves_reverse_proxy_path(self):
        self.assertEqual(
            helpers.normalize_url("https://READER.local/orion/"),
            "https://reader.local/orion",
        )

    def test_rejects_credentials(self):
        username = "user"
        credential = "placeholder"
        with self.assertRaises(ValueError):
            helpers.normalize_url(f"http://{username}:{credential}@reader:8083")

    def test_rejects_unsupported_scheme(self):
        with self.assertRaises(ValueError):
            helpers.normalize_url("ftp://reader.local")


class IntervalUsageTests(unittest.TestCase):
    def test_first_reading_has_no_interval(self):
        readings = {"example-meter": {"reading": 1000}}

        result = helpers.add_interval_usage(readings, None)

        self.assertIsNone(result["example-meter"]["interval_usage_gallons"])

    def test_calculates_usage_from_raw_counter(self):
        readings = {"example-meter": {"reading": 1017}}
        previous = {"example-meter": {"reading": 1000}}

        result = helpers.add_interval_usage(readings, previous)

        self.assertEqual(
            result["example-meter"]["interval_usage_gallons"],
            1.7,
        )

    def test_rejects_negative_reset_delta(self):
        readings = {"example-meter": {"reading_gallons": 50.0}}
        previous = {"example-meter": {"reading_gallons": 100.0}}

        result = helpers.add_interval_usage(readings, previous)

        self.assertIsNone(result["example-meter"]["interval_usage_gallons"])


if __name__ == "__main__":
    unittest.main()
