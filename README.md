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
- Usage from the latest meter reading increase
- Leak state
- Last seen time
- Frequency, RSSI, signal-to-noise ratio, and noise diagnostics

Radio diagnostics are disabled by default and can be enabled from the meter's
entity list.

The endpoint snapshot can roll at a time other than civil midnight. For that
reason, the integration labels the derived value **Usage since endpoint
snapshot**, not daily usage.

## KD Water Meter dashboard

The integration includes the **KD Water Meter** dashboard strategy. It discovers
enabled Orion total-water entities automatically and creates one usage card for
each meter.

After installing or updating the integration and restarting Home Assistant:

1. Open **Settings > Dashboards**.
2. Select **Add dashboard**.
3. Choose **KD Water Meter** under **Community dashboards**.

Each card includes:

- Quick ranges for 30 minutes, 1 hour, 3 hours, 6 hours, 12 hours, 1 day,
  1 week, and 1 month
- Editable start and end date-and-time fields
- A usage graph with one point per recorded meter increase
- Labeled axes, grid lines, a legend, and hover values
- A wider responsive layout with edge-aware chart tooltips
- Total usage for the selected range
- Usage normalized to an hourly pace
- A rolling seven-day daily average
- The latest cumulative meter reading
- A line graph with start and end date pickers directly on the dashboard
- Automatic five-minute, hourly, daily, weekly, or monthly resolution

The graph uses Home Assistant recorder history. The seven-day average displays
after a full seven days of history are available for the meter. Recent ranges
use five-minute statistics so short bursts remain visible; zero-change polling
intervals are omitted. Longer or older ranges automatically use the finest
practical long-term-statistics interval.
Select **Interval usage history** to open the interval usage entity in Home
Assistant History.

## Security

The meter reader API does not provide authentication. Keep it on a trusted local
network and do not expose it to the public internet.

Endpoint IDs are used in Home Assistant device names and registry identifiers.
Water readings, leak state, and timestamps may be retained by the Home Assistant
recorder. Treat Home Assistant backups, databases, and exported diagnostics as
sensitive. The integration does not send meter data to a cloud service.
