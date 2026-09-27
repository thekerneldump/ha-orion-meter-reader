const DOMAIN = "orion_water_meter";
const CARD_TYPE = "orion-water-usage-card";
const HISTORY_CARD_TYPE = "orion-water-history-card";
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

function dateInputValue(date) {
  const adjusted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return adjusted.toISOString().slice(0, 10);
}

function localDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function statisticsPeriod(start, end, now) {
  const span = end - start;
  const age = now - start;
  if (span <= 10 * DAY_MS && age <= 10 * DAY_MS) {
    return "5minute";
  }
  if (span <= 90 * DAY_MS) {
    return "hour";
  }
  if (span <= 2 * 365 * DAY_MS) {
    return "day";
  }
  if (span <= 5 * 365 * DAY_MS) {
    return "week";
  }
  return "month";
}

function periodLabel(period) {
  return {
    "5minute": "5-minute",
    hour: "hourly",
    day: "daily",
    week: "weekly",
    month: "monthly",
  }[period];
}

class OrionWaterHistoryCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._rows = null;
    this._loading = false;
    this._error = null;
    this._requestSequence = 0;
    this._lastFetchAt = 0;
    this._observedUpdate = null;
  }

  setConfig(config) {
    if (!config.entity) {
      throw new Error("Orion Water History Card requires an entity");
    }
    this._config = { ...config };
    const today = new Date();
    this._startDate = config.start_date || dateInputValue(today);
    this._endDate = config.end_date || dateInputValue(today);
    this._rows = null;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    const state = this._config ? hass.states[this._config.entity] : null;
    const update = state?.last_updated || null;
    const stale = Date.now() - this._lastFetchAt >= 5 * 60_000;

    if (
      this._config &&
      !this._loading &&
      (!this._rows || (update !== this._observedUpdate && stale))
    ) {
      this._loadStatistics();
      return;
    }
    this._render();
  }

  getCardSize() {
    return 5;
  }

  _selectedRange() {
    const start = localDate(this._startDate);
    const end = localDate(this._endDate);
    end.setDate(end.getDate() + 1);
    const now = new Date();
    if (end > now) {
      end.setTime(now.getTime());
    }
    return { start, end, now };
  }

  async _loadStatistics() {
    if (!this._hass || !this._config || this._loading) {
      return;
    }

    const { start, end, now } = this._selectedRange();
    if (
      !Number.isFinite(start.getTime()) ||
      !Number.isFinite(end.getTime()) ||
      start >= end
    ) {
      this._error = "Choose an end date on or after the start date.";
      this._render();
      return;
    }

    const sequence = ++this._requestSequence;
    const period = statisticsPeriod(start, end, now);
    this._loading = true;
    this._error = null;
    this._render();

    try {
      const result = await this._hass.callWS({
        type: "recorder/statistics_during_period",
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        statistic_ids: [this._config.entity],
        period,
        types: ["change"],
      });
      if (sequence !== this._requestSequence) {
        return;
      }
      const rawRows = result?.[this._config.entity] || [];
      this._rows = rawRows
        .map((row) => ({
          time: Number(row.start),
          value: Math.max(0, Number(row.change)),
        }))
        .filter(
          (row) => Number.isFinite(row.time) && Number.isFinite(row.value),
        );
      this._period = period;
      this._observedUpdate =
        this._hass.states[this._config.entity]?.last_updated || null;
      this._lastFetchAt = Date.now();
    } catch (_error) {
      if (sequence === this._requestSequence) {
        this._error = "Water statistics could not be loaded.";
      }
    } finally {
      if (sequence === this._requestSequence) {
        this._loading = false;
        this._render();
      }
    }
  }

  _renderLine(rows, start, end, unit) {
    if (!rows.length) {
      return '<div class="message">No statistics are available for this date range yet.</div>';
    }

    const width = 1000;
    const height = 250;
    const left = 36;
    const right = 12;
    const top = 14;
    const bottom = 30;
    const chartWidth = width - left - right;
    const chartHeight = height - top - bottom;
    const maximum = Math.max(...rows.map((row) => row.value), 0);
    const scaleMaximum = maximum || 1;
    const pointFor = (row) => {
      const x = left + ((row.time - start) / (end - start)) * chartWidth;
      const y = top + chartHeight - (row.value / scaleMaximum) * chartHeight;
      return { x: Math.max(left, Math.min(width - right, x)), y };
    };
    const points = rows.map(pointFor);
    const polyline = points.map((point) => `${point.x},${point.y}`).join(" ");
    const area =
      `${left},${top + chartHeight} ` +
      polyline +
      ` ${width - right},${top + chartHeight}`;
    const grid = [0, 0.25, 0.5, 0.75, 1]
      .map((ratio) => {
        const y = top + chartHeight * ratio;
        return `<line x1="${left}" y1="${y}" x2="${width - right}" y2="${y}" />`;
      })
      .join("");
    const dots =
      rows.length <= 300
        ? rows
            .map((row, index) => {
              const point = points[index];
              return `<circle cx="${point.x}" cy="${point.y}" r="3">
                <title>${escapeHtml(formatVolume(row.value, unit))}</title>
              </circle>`;
            })
            .join("")
        : "";
    const axisFormatter = new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: this._period === "5minute" ? "numeric" : undefined,
      minute: this._period === "5minute" ? "2-digit" : undefined,
      timeZone: this._hass?.config?.time_zone,
    });

    return `
      <div class="chart-heading">
        <span>Interval usage</span>
        <span class="muted">highest ${escapeHtml(
          formatVolume(maximum, unit),
        )}</span>
      </div>
      <svg
        class="line-chart"
        viewBox="0 0 ${width} ${height}"
        preserveAspectRatio="none"
        role="img"
        aria-label="Water usage line graph"
      >
        <g class="grid">${grid}</g>
        <polygon class="area" points="${area}" />
        <polyline class="line" points="${polyline}" />
        <g class="dots">${dots}</g>
      </svg>
      <div class="axis">
        <span>${escapeHtml(axisFormatter.format(new Date(start)))}</span>
        <span>${escapeHtml(
          axisFormatter.format(new Date((start + end) / 2)),
        )}</span>
        <span>${escapeHtml(axisFormatter.format(new Date(end)))}</span>
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
      "Water usage history";
    const unit = state?.attributes?.unit_of_measurement || "gal";
    const { start, end } = this._selectedRange();
    const rows = this._rows || [];
    const total = rows.reduce((sum, row) => sum + row.value, 0);
    const historyUrl = `/history?entity_id=${encodeURIComponent(
      this._config.entity,
    )}&back=1`;

    let body;
    if (this._error) {
      body = `<div class="message">${escapeHtml(this._error)}</div>`;
    } else if (this._loading && !this._rows) {
      body = '<div class="message">Loading water statistics…</div>';
    } else {
      body = `
        <div class="summary">
          <span>
            <small>Usage in range</small>
            <strong>${escapeHtml(formatVolume(total, unit))}</strong>
          </span>
          <span>
            <small>Resolution</small>
            <strong>${escapeHtml(periodLabel(this._period || "5minute"))}</strong>
          </span>
        </div>
        ${this._renderLine(rows, start.getTime(), end.getTime(), unit)}
      `;
    }

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
        }
        ha-card {
          overflow: hidden;
          padding: 20px;
        }
        .header,
        .controls,
        .summary,
        .chart-heading,
        .axis {
          display: flex;
          gap: 12px;
          justify-content: space-between;
        }
        .header {
          align-items: center;
          margin-bottom: 16px;
        }
        h2 {
          color: var(--primary-text-color);
          font-size: 20px;
          font-weight: 500;
          line-height: 1.2;
          margin: 0;
        }
        a {
          color: var(--primary-color);
          font-size: 13px;
          text-decoration: none;
          white-space: nowrap;
        }
        a:hover {
          text-decoration: underline;
        }
        .controls {
          background: var(--secondary-background-color);
          border-radius: 12px;
          justify-content: flex-start;
          margin-bottom: 14px;
          padding: 10px 12px;
        }
        label {
          color: var(--secondary-text-color);
          display: flex;
          flex: 1;
          flex-direction: column;
          font-size: 11px;
          gap: 4px;
          min-width: 0;
        }
        input {
          background: var(--card-background-color);
          border: 1px solid var(--divider-color);
          border-radius: 8px;
          box-sizing: border-box;
          color: var(--primary-text-color);
          font: inherit;
          max-width: 190px;
          min-height: 36px;
          padding: 6px 8px;
          width: 100%;
        }
        .summary {
          margin-bottom: 18px;
        }
        .summary span {
          flex: 1;
        }
        small,
        .muted {
          color: var(--secondary-text-color);
          display: block;
          font-size: 12px;
        }
        strong {
          color: var(--primary-text-color);
          display: block;
          font-size: 18px;
          font-weight: 500;
          margin-top: 4px;
        }
        .chart-heading {
          color: var(--primary-text-color);
          font-size: 14px;
          margin-bottom: 6px;
        }
        .line-chart {
          display: block;
          height: 220px;
          overflow: visible;
          width: 100%;
        }
        .grid line {
          stroke: var(--divider-color);
          stroke-width: 1;
          vector-effect: non-scaling-stroke;
        }
        .area {
          fill: color-mix(in srgb, var(--primary-color) 18%, transparent);
        }
        .line {
          fill: none;
          stroke: var(--primary-color);
          stroke-linecap: round;
          stroke-linejoin: round;
          stroke-width: 3;
          vector-effect: non-scaling-stroke;
        }
        .dots circle {
          fill: var(--card-background-color);
          stroke: var(--primary-color);
          stroke-width: 2;
          vector-effect: non-scaling-stroke;
        }
        .axis {
          color: var(--secondary-text-color);
          font-size: 11px;
          margin-top: 4px;
        }
        .message {
          color: var(--secondary-text-color);
          padding: 42px 8px;
          text-align: center;
        }
        @media (max-width: 500px) {
          .header {
            align-items: flex-start;
          }
          .line-chart {
            height: 170px;
          }
        }
      </style>
      <ha-card>
        <div class="header">
          <h2>${escapeHtml(title)}</h2>
          <a href="${escapeHtml(historyUrl)}">Full history →</a>
        </div>
        <div class="controls">
          <label>
            Start date
            <input
              class="start-date"
              type="date"
              value="${escapeHtml(this._startDate)}"
              max="${dateInputValue(new Date())}"
            />
          </label>
          <label>
            End date
            <input
              class="end-date"
              type="date"
              value="${escapeHtml(this._endDate)}"
              max="${dateInputValue(new Date())}"
            />
          </label>
        </div>
        ${body}
      </ha-card>
    `;

    const changeRange = () => {
      this._startDate = this.shadowRoot.querySelector(".start-date").value;
      this._endDate = this.shadowRoot.querySelector(".end-date").value;
      this._rows = null;
      this._loadStatistics();
    };
    this.shadowRoot
      .querySelector(".start-date")
      ?.addEventListener("change", changeRange);
    this.shadowRoot
      .querySelector(".end-date")
      ?.addEventListener("change", changeRange);
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
      ? meters.map((entity) => {
          const meterName =
            hass.states[entity.entity_id]?.attributes?.friendly_name ||
            entity.name ||
            "Water meter";
          return {
            type: "vertical-stack",
            cards: [
              {
                type: `custom:${CARD_TYPE}`,
                entity: entity.entity_id,
                default_hours: 1,
              },
              {
                type: `custom:${HISTORY_CARD_TYPE}`,
                title: `${meterName} usage history`,
                entity: entity.entity_id,
              },
            ],
          };
        })
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

if (!customElements.get(HISTORY_CARD_TYPE)) {
  customElements.define(HISTORY_CARD_TYPE, OrionWaterHistoryCard);
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

if (!window.customCards.some((card) => card.type === HISTORY_CARD_TYPE)) {
  window.customCards.push({
    type: HISTORY_CARD_TYPE,
    name: "Orion Water History",
    description: "Water usage line graph with an on-card date range.",
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
