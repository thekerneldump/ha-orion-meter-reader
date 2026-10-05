const ORION_STRATEGY_TYPE = "orion-water-meter";
const ORION_STRATEGY_ELEMENT =
  `ll-strategy-dashboard-${ORION_STRATEGY_TYPE}`;
const ORION_FRONTEND_VERSION = "0.0.10";
const ORION_RETRY_KEY = "orion-water-meter-strategy-retry";

const implementation = import(
  `./orion-water-meter.js?v=${ORION_FRONTEND_VERSION}`
);

class OrionWaterMeterStrategyLoader extends HTMLElement {
  static noEditor = true;

  static registryDependencies = ["entities", "devices"];

  static getCreateSuggestions() {
    return {
      title: "KD Water Meter",
      icon: "mdi:water",
    };
  }

  static async generate(config, hass) {
    globalThis.sessionStorage?.removeItem(ORION_RETRY_KEY);
    const { OrionWaterMeterDashboardStrategy } = await implementation;
    return OrionWaterMeterDashboardStrategy.generate(config, hass);
  }
}

if (!customElements.get(ORION_STRATEGY_ELEMENT)) {
  customElements.define(
    ORION_STRATEGY_ELEMENT,
    OrionWaterMeterStrategyLoader,
  );
}

window.customStrategies = window.customStrategies || [];
if (
  !window.customStrategies.some(
    (strategy) =>
      strategy.type === ORION_STRATEGY_TYPE &&
      strategy.strategyType === "dashboard",
  )
) {
  window.customStrategies.push({
    type: ORION_STRATEGY_TYPE,
    strategyType: "dashboard",
    name: "KD Water Meter",
    description:
      "Track Orion water usage, hourly pace, and rolling daily averages.",
  });
}

function containsStrategyTimeout(root) {
  const message = `Timeout waiting for strategy element ${ORION_STRATEGY_ELEMENT}`;
  if (root.textContent?.includes(message)) {
    return true;
  }
  for (const element of root.querySelectorAll?.("*") || []) {
    if (element.shadowRoot && containsStrategyTimeout(element.shadowRoot)) {
      return true;
    }
  }
  return false;
}

function recoverLateStrategyRegistration() {
  if (
    typeof document === "undefined" ||
    typeof location === "undefined" ||
    !containsStrategyTimeout(document)
  ) {
    return;
  }
  if (globalThis.sessionStorage?.getItem(ORION_RETRY_KEY)) {
    return;
  }
  globalThis.sessionStorage?.setItem(
    ORION_RETRY_KEY,
    ORION_FRONTEND_VERSION,
  );
  location.reload();
}

for (const delay of [0, 250, 1000]) {
  setTimeout(recoverLateStrategyRegistration, delay);
}
