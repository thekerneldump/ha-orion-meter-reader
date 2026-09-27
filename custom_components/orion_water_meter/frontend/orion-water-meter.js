const DOMAIN = "orion_water_meter";
const CARD_TYPE = "orion-water-usage-card";
const STRATEGY_TYPE = "orion-water-meter";
const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_DAYS = 7;

const RANGES = [
  { hours: 0.5, label: "30m", bucketMinutes: 5 },
  { hours: 1, label: "1h", bucketMinutes: 5 },
  { hours: 3, label: "3h", bucketMinutes: 15 },
  { hours: 6, label: "6h", bucketMinutes: 30 },
  { hours: 12, label: "12h", bucketMinutes: 60 },
  { hours: 24, label: "24h", bucketMinutes: 60 },
];

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function numericState(state) {
  const value = Number(state);
  return Number.isFinite(value) ? value : null;
}

function normalizeHistory(rawHistory, currentState) {
  const points = [];
  for (const item of rawHistory) {
    const alreadyNormalized =
      Number.isFinite(item.value) && Number.isFinite(item.time);
    const value = alreadyNormalized ? item.value : numericState(item.state);
    const time = alreadyNormalized
      ? item.time
      : Date.parse(item.last_updated || item.last_changed || "");
    if (value !== null && Number.isFinite(time)) {
      points.push({ time, value });
    }
  }

  if (currentState) {
    const value = numericState(currentState.state);
    const time = Date.parse(
      currentState.last_updated || currentState.last_changed || "",
    );
    if (value !== null && Number.isFinite(time)) {
      points.push({ time, value });
    }
  }

  points.sort((left, right) => left.time - right.time);
  return points.filter(
    (point, index) =>
      index === 0 ||
      point.time !== points[index - 1].time ||
      point.value !== points[index - 1].value,
  );
}

function rangePoints(points, start, end) {
  let baseline = null;
  const selected = [];

  for (const point of points) {
    if (point.time <= start) {
      baseline = point;
    } else if (point.time <= end) {
      selected.push(point);
    }
  }

  if (baseline) {
    selected.unshift(baseline);
  }
  return selected;
}

function positiveUsage(points) {
  let usage = 0;
  for (let index = 1; index < points.length; index += 1) {
    const delta = points[index].value - points[index - 1].value;
    if (delta >= 0) {
      usage += delta;
    }
  }
  return usage;
}

function usageBuckets(points, start, end, bucketMinutes) {
  const bucketMs = bucketMinutes * 60 * 1000;
  const count = Math.ceil((end - start) / bucketMs);
  const buckets = Array.from({ length: count }, () => 0);
  const selected = rangePoints(points, start, end);

  for (let index = 1; index < selected.length; index += 1) {
    const point = selected[index];
    const delta = point.value - selected[index - 1].value;
    if (delta < 0 || point.time <= start) {
      continue;
    }
    const bucket = Math.min(
      count - 1,
      Math.floor((point.time - start) / bucketMs),
    );
    buckets[bucket] += delta;
  }
  return buckets;
}

function formatVolume(value, unit) {
  if (value === null || !Number.isFinite(value)) {
    return "—";
  }
  const formatted = new Intl.NumberFormat(undefined, {
    maximumFractionDigits: value < 10 ? 2 : 1,
    minimumFractionDigits: 0,
  }).format(value);
  return `${formatted} ${unit}`;
}

class OrionWaterUsageCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._rangeHours = 1;
    this._points = null;
    this._loading = false;
    this._error = false;
    this._lastFetchAt = 0;
    this._observedUpdate = null;
    this._requestSequence = 0;
  }

  setConfig(config) {
    if (!config.entity) {
      throw new Error("Orion Water Usage Card requires an entity");
    }
    this._config = { ...config };
    this._rangeHours = Number(config.default_hours) || 1;
    if (!RANGES.some((range) => range.hours === this._rangeHours)) {
      this._rangeHours = 1;
    }
    this._points = null;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    const state = this._config ? hass.states[this._config.entity] : null;
    const update = state?.last_updated || null;
    const stale = Date.now() - this._lastFetchAt >= 60_000;

    if (
      this._config &&
      !this._loading &&
      (!this._points || (update !== this._observedUpdate && stale))
    ) {
      this._loadHistory();
      return;
    }
    this._render();
  }

  getCardSize() {
    return 5;
  }

  async _loadHistory() {
    if (!this._hass || !this._config || this._loading) {
      return;
    }

    const sequence = ++this._requestSequence;
    this._loading = true;
    this._error = false;
    this._render();

    const end = new Date();
    const start = new Date(end.getTime() - (HISTORY_DAYS + 1) * DAY_MS);
    const entity = this._config.entity;
    const path =
      `history/period/${encodeURIComponent(start.toISOString())}` +
      `?filter_entity_id=${encodeURIComponent(entity)}` +
      `&end_time=${encodeURIComponent(end.toISOString())}` +
      "&minimal_response";

    try {
      const result = await this._hass.callApi("GET", path);
      if (sequence !== this._requestSequence) {
        return;
      }
      const history = Array.isArray(result?.[0]) ? result[0] : [];
      const currentState = this._hass.states[entity];
      this._points = normalizeHistory(history, currentState);
      this._observedUpdate = currentState?.last_updated || null;
      this._lastFetchAt = Date.now();
    } catch (_error) {
      if (sequence === this._requestSequence) {
        this._error = true;
      }
    } finally {
      if (sequence === this._requestSequence) {
        this._loading = false;
        this._render();
      }
    }
  }

  _dailyAverage(points, now) {
    const start = now - HISTORY_DAYS * DAY_MS;
    if (!points.length || points[0].time > start + 5 * 60 * 1000) {
      return null;
    }
    return positiveUsage(rangePoints(points, start, now)) / HISTORY_DAYS;
  }

  _renderChart(buckets, start, end, bucketMinutes, unit) {
    const maximum = Math.max(...buckets, 0);
    const formatter = new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      timeZone: this._hass?.config?.time_zone,
    });
    const bars = buckets
      .map((value, index) => {
        const height = maximum > 0 ? Math.max(2, (value / maximum) * 100) : 2;
        const bucketTime = new Date(
          start + index * bucketMinutes * 60 * 1000,
        );
        const label = `${formatter.format(bucketTime)}: ${formatVolume(
          value,
          unit,
        )}`;
        return `<div class="bar-wrap" title="${escapeHtml(label)}">
          <div class="bar" style="height: ${height}%"></div>
        </div>`;
      })
      .join("");

    return `
      <div class="chart-heading">
        <span>Usage by ${bucketMinutes} minute${bucketMinutes === 1 ? "" : "s"}</span>
        <span class="muted">max ${escapeHtml(formatVolume(maximum, unit))}</span>
      </div>
      <div class="chart" role="img" aria-label="Water usage bar chart">
        ${bars}
      </div>
      <div class="axis">
        <span>${escapeHtml(formatter.format(new Date(start)))}</span>
        <span>${escapeHtml(formatter.format(new Date((start + end) / 2)))}</span>
        <span>${escapeHtml(formatter.format(new Date(end)))}</span>
      </div>
    `;
  }

  _render() {
    if (!this.shadowRoot || !this._config) {
      return;
    }

    const state = this._hass?.states?.[this._config.entity];
    const title =
      this._config.title ||
      state?.attributes?.friendly_name ||
      "Orion Water Meter";
    const unit = state?.attributes?.unit_of_measurement || "gal";
    const now = Date.now();
    const selectedRange =
      RANGES.find((range) => range.hours === this._rangeHours) || RANGES[1];
    const start = now - selectedRange.hours * 60 * 60 * 1000;
    const points = this._points
      ? normalizeHistory(this._points, state)
      : [];
    const selectedPoints = rangePoints(points, start, now);
    const usage = points.length ? positiveUsage(selectedPoints) : null;
    const hourlyPace =
      usage === null ? null : usage / selectedRange.hours;
    const dailyAverage = this._dailyAverage(points, now);
    const buckets = usageBuckets(
      points,
      start,
      now,
      selectedRange.bucketMinutes,
    );

    const buttons = RANGES.map(
      (range) =>
        `<button
          class="${range.hours === this._rangeHours ? "active" : ""}"
          data-hours="${range.hours}"
          type="button"
        >${range.label}</button>`,
    ).join("");

    let body;
    if (this._error) {
      body = `
        <div class="message">
          Recorder history could not be loaded.
          <button class="retry" type="button">Retry</button>
        </div>`;
    } else if (this._loading && !this._points) {
      body = '<div class="message">Loading water history…</div>';
    } else if (!state) {
      body = '<div class="message">The configured water sensor is unavailable.</div>';
    } else {
      body = `
        <div class="stats">
          <div class="stat">
            <span class="stat-label">${selectedRange.label} usage</span>
            <strong>${escapeHtml(formatVolume(usage, unit))}</strong>
          </div>
          <div class="stat">
            <span class="stat-label">Hourly pace</span>
            <strong>${
              hourlyPace === null
                ? "—"
                : `${escapeHtml(formatVolume(hourlyPace, unit))}/h`
            }</strong>
          </div>
          <div class="stat">
            <span class="stat-label">7-day daily average</span>
            <strong>${escapeHtml(formatVolume(dailyAverage, unit))}</strong>
          </div>
        </div>
        ${this._renderChart(
          buckets,
          start,
          now,
          selectedRange.bucketMinutes,
          unit,
        )}
        <div class="footer">
          <span>Total meter reading</span>
          <span>${escapeHtml(formatVolume(numericState(state.state), unit))}</span>
        </div>
      `;
    }

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
        }
        ha-card {
          padding: 20px;
          overflow: hidden;
        }
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 16px;
        }
        h2 {
          color: var(--primary-text-color);
          font-size: 20px;
          font-weight: 500;
          line-height: 1.2;
          margin: 0;
        }
        .filters {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }
        button {
          background: var(--secondary-background-color);
          border: 0;
          border-radius: 999px;
          color: var(--secondary-text-color);
          cursor: pointer;
          font: inherit;
          min-height: 32px;
          padding: 5px 11px;
        }
        button:hover {
          background: color-mix(
            in srgb,
            var(--primary-color) 16%,
            var(--secondary-background-color)
          );
        }
        button.active {
          background: var(--primary-color);
          color: var(--text-primary-color, white);
        }
        .stats {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 10px;
          margin-bottom: 22px;
        }
        .stat {
          background: var(--secondary-background-color);
          border-radius: 12px;
          min-width: 0;
          padding: 12px;
        }
        .stat-label,
        .muted,
        .footer {
          color: var(--secondary-text-color);
          font-size: 12px;
        }
        strong {
          color: var(--primary-text-color);
          display: block;
          font-size: 19px;
          font-weight: 500;
          margin-top: 5px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .chart-heading,
        .axis,
        .footer {
          display: flex;
          justify-content: space-between;
          gap: 8px;
        }
        .chart-heading {
          color: var(--primary-text-color);
          font-size: 14px;
          margin-bottom: 8px;
        }
        .chart {
          align-items: end;
          border-bottom: 1px solid var(--divider-color);
          display: flex;
          gap: 4px;
          height: 150px;
        }
        .bar-wrap {
          align-items: end;
          display: flex;
          flex: 1;
          height: 100%;
          min-width: 2px;
        }
        .bar {
          background: linear-gradient(
            180deg,
            var(--primary-color),
            var(--light-primary-color, var(--primary-color))
          );
          border-radius: 4px 4px 0 0;
          min-height: 2px;
          transition: height 180ms ease;
          width: 100%;
        }
        .axis {
          color: var(--secondary-text-color);
          font-size: 11px;
          margin-top: 5px;
        }
        .footer {
          border-top: 1px solid var(--divider-color);
          margin-top: 18px;
          padding-top: 12px;
        }
        .message {
          color: var(--secondary-text-color);
          padding: 36px 8px;
          text-align: center;
        }
        .retry {
          color: var(--primary-color);
          margin-left: 8px;
        }
        @media (max-width: 600px) {
          .header {
            align-items: flex-start;
            flex-direction: column;
          }
          .stats {
            grid-template-columns: 1fr;
          }
          .chart {
            height: 120px;
          }
        }
      </style>
      <ha-card>
        <div class="header">
          <h2>${escapeHtml(title)}</h2>
          <div class="filters" aria-label="History range">${buttons}</div>
        </div>
        ${body}
      </ha-card>
    `;

    this.shadowRoot.querySelectorAll("[data-hours]").forEach((button) => {
      button.addEventListener("click", () => {
        this._rangeHours = Number(button.dataset.hours);
        this._render();
      });
    });
    this.shadowRoot.querySelector(".retry")?.addEventListener("click", () => {
      this._loadHistory();
    });
  }
}

class OrionWaterMeterDashboardStrategy extends HTMLElement {
  static noEditor = true;

  static registryDependencies = ["entities"];

  static getCreateSuggestions() {
    return {
      title: "KD Water Meter",
      icon: "mdi:water",
    };
  }

  static async generate(config, hass) {
    const registry = await hass.callWS({
      type: "config/entity_registry/list",
    });
    const meters = registry
      .filter(
        (entity) =>
          entity.platform === DOMAIN &&
          entity.entity_id.startsWith("sensor.") &&
          entity.unique_id?.endsWith("_reading_gallons") &&
          !entity.disabled_by,
      )
      .sort((left, right) => left.entity_id.localeCompare(right.entity_id));

    const cards = meters.length
      ? meters.map((entity) => ({
          type: `custom:${CARD_TYPE}`,
          entity: entity.entity_id,
          default_hours: 1,
        }))
      : [
          {
            type: "markdown",
            title: "Orion Water Meter",
            content:
              "No enabled total-water entities were found. " +
              "Configure the Orion Water Meter integration and wait for a reading.",
          },
        ];

    return {
      title: config.title || "KD Water Meter",
      views: [
        {
          title: "Water",
          path: "water",
          icon: "mdi:water",
          cards,
        },
      ],
    };
  }
}

if (!customElements.get(CARD_TYPE)) {
  customElements.define(CARD_TYPE, OrionWaterUsageCard);
}

const strategyElement = `ll-strategy-dashboard-${STRATEGY_TYPE}`;
if (!customElements.get(strategyElement)) {
  customElements.define(strategyElement, OrionWaterMeterDashboardStrategy);
}

window.customCards = window.customCards || [];
if (!window.customCards.some((card) => card.type === CARD_TYPE)) {
  window.customCards.push({
    type: CARD_TYPE,
    name: "Orion Water Usage",
    description: "Water usage history with selectable time ranges.",
    preview: false,
  });
}

window.customStrategies = window.customStrategies || [];
if (
  !window.customStrategies.some(
    (strategy) =>
      strategy.type === STRATEGY_TYPE &&
      strategy.strategyType === "dashboard",
  )
) {
  window.customStrategies.push({
    type: STRATEGY_TYPE,
    strategyType: "dashboard",
    name: "KD Water Meter",
    description:
      "Track Orion water usage, hourly pace, and rolling daily averages.",
  });
}
