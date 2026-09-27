# Changelog

## 0.0.2

- Add an automatically discovered water-usage dashboard strategy.
- Add selectable 30-minute through 24-hour usage graphs.
- Add selected-period usage, hourly pace, and rolling daily-average summaries.

## 0.0.1

Initial release.

- Configure and reconfigure a local Orion Meter Reader through the Home Assistant UI.
- Discover new Badger ORION endpoints automatically.
- Create a Home Assistant device for each discovered water meter.
- Report cumulative water and usage since the endpoint snapshot.
- Report leak state and last-seen time.
- Provide optional frequency, RSSI, signal-to-noise, and noise diagnostics.
- Poll locally without sending meter data to a cloud service.
