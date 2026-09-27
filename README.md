# Orion Water Meter

Orion Water Meter is a Home Assistant custom integration for the local Orion
Meter Reader web interface. It polls the reader's `/api/readings` endpoint and
creates one Home Assistant device for each discovered Badger ORION endpoint.

Home Assistant 2026.8.0 or newer is required.

## Installation with HACS

1. Open HACS in Home Assistant.
2. Add this repository as a custom repository with type **Integration**.
3. Install **Orion Water Meter**.
4. Restart Home Assistant.

## Manual installation

Copy `custom_components/orion_water_meter` into Home Assistant's
`/config/custom_components/` directory, then restart Home Assistant.

## Configuration

1. Open **Settings > Devices & services**.
2. Select **Add integration**.
3. Search for **Orion Water Meter**.
4. Enter the Orion Meter Reader base URL, such as
   `http://<reader-host>:8083`, and choose a polling interval.

The Home Assistant host must be able to reach `<base-url>/api/readings`. The
default polling interval is 15 seconds. The URL and interval can be changed later
with **Reconfigure** on the integration entry.

## Devices and entities

The integration creates a web-interface hub device and one meter device for each
endpoint ID returned by the API. New endpoint IDs are discovered automatically.

Each meter provides:

- Total water
- Usage since endpoint snapshot
- Leak state
- Last seen time
- Frequency, RSSI, signal-to-noise ratio, and noise diagnostics

Radio diagnostics are disabled by default and can be enabled from the meter's
entity list.

The endpoint snapshot can roll at a time other than civil midnight. For that
reason, the integration labels the derived value **Usage since endpoint
snapshot**, not daily usage.

## Security

The meter reader API does not provide authentication. Keep it on a trusted local
network and do not expose it to the public internet.

Endpoint IDs are used in Home Assistant device names and registry identifiers.
Water readings, leak state, and timestamps may be retained by the Home Assistant
recorder. Treat Home Assistant backups, databases, and exported diagnostics as
sensitive. The integration does not send meter data to a cloud service.
