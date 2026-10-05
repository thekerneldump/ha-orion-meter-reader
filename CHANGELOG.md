# Changelog

## 0.0.7

- Add configurable friendly names for discovered meter devices.
- Reload the integration automatically after a meter name changes.

## 0.0.6

- Widen dashboard cards with a centered panel layout.
- Keep chart tooltips visible near the left and right edges.

## 0.0.5

- Plot one line-graph point per recorded meter increase.
- Omit unchanged polling intervals instead of displaying misleading zeroes.
- Retain the latest interval-usage value until the meter reports a new reading.

## 0.0.4

- Add a per-meter interval usage entity.
- Add date-and-time inputs and quick ranges from 30 minutes through one month.
- Add labeled axes, grid lines, a legend, and hover values to the usage chart.
- Link the chart to the interval usage entity's history.

## 0.0.3

- Add an interval-usage line graph with on-dashboard date pickers.
- Automatically preserve granular resolution for short and recent ranges.
- Add a link from the graph to full entity history.

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
