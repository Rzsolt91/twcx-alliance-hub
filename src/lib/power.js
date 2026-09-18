/**
 * Power fields shared by onboarding, profile and the roster.
 * Accepts 65M, 65,32M and 65000000 — same parser the spreadsheet import uses.
 */

import { input } from "./dom.js";
import { formatPower, parsePower } from "../../shared/power.ts";
import { t } from "./i18n.js";

export { formatPower, parsePower };

export function powerInput(value = 0) {
  const numeric = typeof value === "number" ? value : parsePower(value);
  return input({
    type: "text",
    inputmode: "decimal",
    autocomplete: "off",
    spellcheck: "false",
    value: Number.isFinite(numeric) && numeric > 0 ? formatPower(numeric) : "",
    placeholder: "65.32M",
    "aria-label": t("power.hint"),
  });
}

/** Live total while typing compact forms like 65M. */
export function powerSum(nodes) {
  return nodes.reduce((sum, node) => {
    const value = parsePower(node?.value);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);
}

export function readPowerForm({ air, tank, missile, thp }) {
  const airPower = parsePower(air.value);
  const tankPower = parsePower(tank.value);
  const missilePower = parsePower(missile.value);
  const heroPower = parsePower(thp.value);
  if (![airPower, tankPower, missilePower, heroPower].every(Number.isFinite)) {
    throw new Error(t("power.invalid"));
  }
  return { airPower, tankPower, missilePower, thp: heroPower };
}
