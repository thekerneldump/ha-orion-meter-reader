const DOMAIN = "orion_water_meter";
const CARD_TYPE = "orion-water-usage-card";
const HISTORY_CARD_TYPE = "orion-water-history-card";
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
    this._renderedUpdate = undefined;
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
    if (update !== this._renderedUpdate) {
      this._render();
    }
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
    this._renderedUpdate = state?.last_updated || null;
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
          margin: 0 auto;
          max-width: 900px;
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

function dateTimeInputValue(date) {
  const adjusted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return adjusted.toISOString().slice(0, 16);
}

function quickRangeStart(range, end) {
  const start = new Date(end);
  const durations = {
    "30m": 30 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "3h": 3 * 60 * 60 * 1000,
    "6h": 6 * 60 * 60 * 1000,
    "12h": 12 * 60 * 60 * 1000,
    "1d": DAY_MS,
    "1w": 7 * DAY_MS,
  };
  if (range === "1mo") {
    start.setMonth(start.getMonth() - 1);
    return start;
  }
  return new Date(end.getTime() - durations[range]);
}

function niceMaximum(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return 1;
  }
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const multiplier =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return multiplier * magnitude;
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
    this._renderedUpdate = undefined;
  }

  setConfig(config) {
    if (!config.entity) {
      throw new Error("Orion Water History Card requires an entity");
    }
    this._config = { ...config };
    const end = new Date();
    const start = quickRangeStart("1d", end);
    const supportedRanges = new Set([
      "custom",
      "30m",
      "1h",
      "3h",
      "6h",
      "12h",
      "1d",
      "1w",
      "1mo",
    ]);
    this._rangePreset = supportedRanges.has(config.range) ? config.range : "1d";
    this._startDateTime =
      config.start_time ||
      dateTimeInputValue(
        this._rangePreset === "custom"
          ? start
          : quickRangeStart(this._rangePreset, end),
      );
    this._endDateTime = config.end_time || dateTimeInputValue(end);
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
    if (
      update !== this._renderedUpdate &&
      !this.shadowRoot?.activeElement
    ) {
      this._render();
    }
  }

  getCardSize() {
    return 5;
  }

  _selectedRange() {
    const start = new Date(this._startDateTime);
    const end = new Date(this._endDateTime);
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
          value: Number(row.change),
        }))
        .filter(
          (row) =>
            Number.isFinite(row.time) &&
            Number.isFinite(row.value) &&
            row.value > 0,
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
      return '<div class="message">No meter increases were recorded in this date range.</div>';
    }

    const width = 700;
    const height = 300;
    const left = 58;
    const right = 12;
    const top = 24;
    const bottom = 42;
    const chartWidth = width - left - right;
    const chartHeight = height - top - bottom;
    const maximum = Math.max(...rows.map((row) => row.value), 0);
    const scaleMaximum = niceMaximum(maximum);
    const pointFor = (row) => {
      const x = left + ((row.time - start) / (end - start)) * chartWidth;
      const y = top + chartHeight - (row.value / scaleMaximum) * chartHeight;
      return { x: Math.max(left, Math.min(width - right, x)), y };
    };
    const points = rows.map(pointFor);
    this._chartPoints = rows.map((row, index) => ({
      ...points[index],
      time: row.time,
      value: row.value,
    }));
    this._chartGeometry = { width, height };
    const polyline = points.map((point) => `${point.x},${point.y}`).join(" ");
    const yTicks = [0, 0.25, 0.5, 0.75, 1]
      .map((ratio) => {
        const y = top + chartHeight * ratio;
        const value = scaleMaximum * (1 - ratio);
        return `
          <line x1="${left}" y1="${y}" x2="${width - right}" y2="${y}" />
          <text x="${left - 8}" y="${y + 4}" text-anchor="end">${escapeHtml(
            new Intl.NumberFormat(undefined, {
              maximumFractionDigits: value < 1 ? 2 : value < 10 ? 1 : 0,
            }).format(value),
          )}</text>
        `;
      })
      .join("");
    const span = end - start;
    const axisFormatter = new Intl.DateTimeFormat(
      undefined,
      span <= DAY_MS
        ? {
            hour: "numeric",
            minute: "2-digit",
            timeZone: this._hass?.config?.time_zone,
          }
        : span <= 7 * DAY_MS
          ? {
              weekday: "short",
              hour: "numeric",
              timeZone: this._hass?.config?.time_zone,
            }
          : {
              month: "short",
              day: "numeric",
              timeZone: this._hass?.config?.time_zone,
            },
    );
    const xTicks = Array.from({ length: 6 }, (_, index) => index / 5)
      .map((ratio) => {
        const x = left + chartWidth * ratio;
        const time = start + span * ratio;
        return `
          <line x1="${x}" y1="${top}" x2="${x}" y2="${top + chartHeight}" />
          <text x="${x}" y="${height - 12}" text-anchor="${
            ratio === 0 ? "start" : ratio === 1 ? "end" : "middle"
          }">${escapeHtml(axisFormatter.format(new Date(time)))}</text>
        `;
      })
      .join("");
    const dots = rows
      .map((row, index) => {
        const point = points[index];
        return `<circle cx="${point.x}" cy="${point.y}" r="2.5" />`;
      })
      .join("");

    return `
      <div class="chart-heading">
        <span>Water usage at each recorded update</span>
        <span class="muted">${escapeHtml(unit)}</span>
      </div>
      <div class="chart-shell">
        <svg
          class="line-chart"
          viewBox="0 0 ${width} ${height}"
          role="img"
          aria-label="Water usage line graph"
        >
          <g class="grid y-grid">${yTicks}</g>
          <g class="grid x-grid">${xTicks}</g>
          <polyline class="line" points="${polyline}" />
          <g class="dots">${dots}</g>
          <line class="hover-line" y1="${top}" y2="${top + chartHeight}" hidden />
          <circle class="hover-dot" r="5" hidden />
        </svg>
        <div class="chart-tooltip" hidden></div>
      </div>
      <div class="legend">
        <span class="legend-mark"></span>
        <span>Interval water usage</span>
        <strong>total ${escapeHtml(
          formatVolume(rows.reduce((sum, row) => sum + row.value, 0), unit),
        )}</strong>
      </div>
    `;
  }

  _attachChartHover(unit) {
    const chart = this.shadowRoot.querySelector(".line-chart");
    const tooltip = this.shadowRoot.querySelector(".chart-tooltip");
    const hoverLine = this.shadowRoot.querySelector(".hover-line");
    const hoverDot = this.shadowRoot.querySelector(".hover-dot");
    if (
      !chart ||
      !tooltip ||
      !hoverLine ||
      !hoverDot ||
      !this._chartPoints?.length
    ) {
      return;
    }

    const formatter = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: this._hass?.config?.time_zone,
    });
    chart.addEventListener("pointermove", (event) => {
      const bounds = chart.getBoundingClientRect();
      const x =
        ((event.clientX - bounds.left) / bounds.width) *
        this._chartGeometry.width;
      const point = this._chartPoints.reduce((closest, candidate) =>
        Math.abs(candidate.x - x) < Math.abs(closest.x - x)
          ? candidate
          : closest,
      );
      hoverLine.setAttribute("x1", point.x);
      hoverLine.setAttribute("x2", point.x);
      hoverLine.hidden = false;
      hoverDot.setAttribute("cx", point.x);
      hoverDot.setAttribute("cy", point.y);
      hoverDot.hidden = false;
      tooltip.textContent = `${formatter.format(
        new Date(point.time),
      )} · ${formatVolume(point.value, unit)}`;
      const horizontalPosition = point.x / this._chartGeometry.width;
      tooltip.style.left = `${horizontalPosition * 100}%`;
      tooltip.style.top = `${(point.y / this._chartGeometry.height) * 100}%`;
      tooltip.style.transform = `translate(${
        horizontalPosition < 0.25
          ? "0"
          : horizontalPosition > 0.75
            ? "-100%"
            : "-50%"
      }, calc(-100% - 10px))`;
      tooltip.hidden = false;
    });
    chart.addEventListener("pointerleave", () => {
      hoverLine.hidden = true;
      hoverDot.hidden = true;
      tooltip.hidden = true;
    });
  }

  _render() {
    if (!this.shadowRoot || !this._config) {
      return;
    }

    const state = this._hass?.states?.[this._config.entity];
    this._renderedUpdate = state?.last_updated || null;
    const title =
      this._config.title ||
      state?.attributes?.friendly_name ||
      "Water usage history";
    const unit = state?.attributes?.unit_of_measurement || "gal";
    const { start, end } = this._selectedRange();
    const rows = this._rows || [];
    const total = rows.reduce((sum, row) => sum + row.value, 0);
    const historyUrl = `/history?entity_id=${encodeURIComponent(
      this._config.link_entity || this._config.entity,
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
          margin: 0 auto;
          max-width: 900px;
        }
        ha-card {
          overflow: hidden;
          padding: 20px;
        }
        .header,
        .summary,
        .chart-heading,
        .legend {
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
          display: grid;
          gap: 10px 12px;
          grid-template-columns: 1fr 1fr;
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
        label.range {
          grid-column: 1 / -1;
        }
        input,
        select {
          background: var(--card-background-color);
          border: 1px solid var(--divider-color);
          border-radius: 8px;
          box-sizing: border-box;
          color: var(--primary-text-color);
          font: inherit;
          max-width: none;
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
          aspect-ratio: 7 / 3;
          display: block;
          height: auto;
          overflow: visible;
          touch-action: none;
          width: 100%;
        }
        .grid line {
          stroke: var(--divider-color);
          stroke-width: 1;
          vector-effect: non-scaling-stroke;
        }
        .grid text {
          fill: var(--secondary-text-color);
          font-size: 11px;
        }
        .x-grid line {
          opacity: 0.55;
        }
        .line {
          fill: none;
          stroke: #03a9f4;
          stroke-linecap: round;
          stroke-linejoin: round;
          stroke-width: 2.5;
          vector-effect: non-scaling-stroke;
        }
        .dots circle {
          fill: var(--card-background-color);
          stroke: #03a9f4;
          stroke-width: 2;
          vector-effect: non-scaling-stroke;
        }
        .chart-shell {
          position: relative;
        }
        .hover-line {
          stroke: var(--secondary-text-color);
          stroke-dasharray: 4 4;
          stroke-width: 1;
          vector-effect: non-scaling-stroke;
        }
        .hover-dot {
          fill: var(--card-background-color);
          stroke: #03a9f4;
          stroke-width: 3;
          vector-effect: non-scaling-stroke;
        }
        .hover-line[hidden],
        .hover-dot[hidden],
        .chart-tooltip[hidden] {
          display: none;
        }
        .chart-tooltip {
          background: var(--primary-text-color);
          border-radius: 6px;
          color: var(--card-background-color);
          font-size: 12px;
          padding: 6px 8px;
          pointer-events: none;
          position: absolute;
          transform: translate(-50%, calc(-100% - 10px));
          white-space: nowrap;
          z-index: 1;
        }
        .legend {
          align-items: center;
          border-top: 1px solid var(--divider-color);
          color: var(--primary-text-color);
          font-size: 13px;
          justify-content: flex-start;
          margin-top: 8px;
          padding-top: 12px;
        }
        .legend-mark {
          background: #03a9f4;
          border-radius: 50%;
          height: 11px;
          width: 11px;
        }
        .legend strong {
          font-size: 13px;
          margin: 0 0 0 auto;
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
          .controls {
            display: grid;
            grid-template-columns: 1fr;
          }
          input,
          select {
            max-width: none;
          }
        }
      </style>
      <ha-card>
        <div class="header">
          <h2>${escapeHtml(title)}</h2>
          <a href="${escapeHtml(historyUrl)}">Interval usage history →</a>
        </div>
        <div class="controls">
          <label class="range">
            Quick range
            <select class="quick-range">
              <option value="custom" ${
                this._rangePreset === "custom" ? "selected" : ""
              }>Custom</option>
              <option value="30m" ${
                this._rangePreset === "30m" ? "selected" : ""
              }>30 minutes</option>
              <option value="1h" ${
                this._rangePreset === "1h" ? "selected" : ""
              }>1 hour</option>
              <option value="3h" ${
                this._rangePreset === "3h" ? "selected" : ""
              }>3 hours</option>
              <option value="6h" ${
                this._rangePreset === "6h" ? "selected" : ""
              }>6 hours</option>
              <option value="12h" ${
                this._rangePreset === "12h" ? "selected" : ""
              }>12 hours</option>
              <option value="1d" ${
                this._rangePreset === "1d" ? "selected" : ""
              }>1 day</option>
              <option value="1w" ${
                this._rangePreset === "1w" ? "selected" : ""
              }>1 week</option>
              <option value="1mo" ${
                this._rangePreset === "1mo" ? "selected" : ""
              }>1 month</option>
            </select>
          </label>
          <label>
            Start date and time
            <input
              class="start-time"
              type="datetime-local"
              step="60"
              value="${escapeHtml(this._startDateTime)}"
              max="${dateTimeInputValue(new Date())}"
            />
          </label>
          <label>
            End date and time
            <input
              class="end-time"
              type="datetime-local"
              step="60"
              value="${escapeHtml(this._endDateTime)}"
              max="${dateTimeInputValue(new Date())}"
            />
          </label>
        </div>
        ${body}
      </ha-card>
    `;

    const changeCustomRange = () => {
      this._rangePreset = "custom";
      this._startDateTime =
        this.shadowRoot.querySelector(".start-time").value;
      this._endDateTime = this.shadowRoot.querySelector(".end-time").value;
      this._rows = null;
      this._loadStatistics();
    };
    this.shadowRoot
      .querySelector(".start-time")
      ?.addEventListener("change", changeCustomRange);
    this.shadowRoot
      .querySelector(".end-time")
      ?.addEventListener("change", changeCustomRange);
    this.shadowRoot
      .querySelector(".quick-range")
      ?.addEventListener("change", (event) => {
        const range = event.target.value;
        this._rangePreset = range;
        if (range === "custom") {
          return;
        }
        const endTime = new Date();
        this._startDateTime = dateTimeInputValue(
          quickRangeStart(range, endTime),
        );
        this._endDateTime = dateTimeInputValue(endTime);
        this._rows = null;
        this._loadStatistics();
      });
    this._attachChartHover(unit);
  }
}

class OrionWaterMeterDashboardStrategy extends HTMLElement {
  static noEditor = true;

  static registryDependencies = ["entities", "devices"];

  static getCreateSuggestions() {
    return {
      title: "KD Water Meter",
      icon: "mdi:water",
    };
  }

  static async generate(config, hass) {
    const [registry, devices] = await Promise.all([
      hass.callWS({ type: "config/entity_registry/list" }),
      hass.callWS({ type: "config/device_registry/list" }),
    ]);
    const devicesById = new Map(
      devices.map((device) => [device.id, device]),
    );
    const meters = registry
      .filter(
        (entity) =>
          entity.platform === DOMAIN &&
          entity.entity_id.startsWith("sensor.") &&
          entity.unique_id?.endsWith("_reading_gallons") &&
          !entity.disabled_by,
      )
      .map((entity) => {
        const device = devicesById.get(entity.device_id);
        const domainIdentifier = device?.identifiers?.find(
          (identifier) =>
            Array.isArray(identifier) && identifier[0] === DOMAIN,
        );
        const suffix = "_reading_gallons";
        const uniqueStem = entity.unique_id.slice(0, -suffix.length);
        const meterId = String(
          domainIdentifier?.[1] || uniqueStem.split("_").at(-1),
        );
        const defaultDeviceName = `Orion meter ${meterId}`;
        const configuredName = device?.name_by_user || device?.name;
        const friendlyName =
          configuredName && configuredName !== defaultDeviceName
            ? configuredName
            : "Orion meter";
        return {
          entity,
          meterName: `${friendlyName} (${meterId})`,
        };
      })
      .sort((left, right) =>
        left.meterName.localeCompare(right.meterName),
      );
    const intervalByDevice = new Map(
      registry
        .filter(
          (entity) =>
            entity.platform === DOMAIN &&
            entity.entity_id.startsWith("sensor.") &&
            entity.unique_id?.endsWith("_interval_usage_gallons") &&
            !entity.disabled_by &&
            entity.device_id,
        )
        .map((entity) => [entity.device_id, entity.entity_id]),
    );

    const cards = meters.length
      ? meters.map(({ entity, meterName }) => {
          return {
            type: "vertical-stack",
            cards: [
              {
                type: `custom:${CARD_TYPE}`,
                title: meterName,
                entity: entity.entity_id,
                default_hours: 1,
              },
              {
                type: `custom:${HISTORY_CARD_TYPE}`,
                title: `${meterName} usage history`,
                entity: entity.entity_id,
                link_entity:
                  intervalByDevice.get(entity.device_id) || entity.entity_id,
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

    const panelCard =
      cards.length === 1 ? cards[0] : { type: "vertical-stack", cards };

    return {
      title: config.title || "KD Water Meter",
      views: [
        {
          title: "Water",
          path: "water",
          icon: "mdi:water",
          panel: true,
          cards: [panelCard],
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

export { OrionWaterMeterDashboardStrategy };
