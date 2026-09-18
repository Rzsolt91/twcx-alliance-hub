/** Roster and squads: own power readings, the full roster and progress trends. */

import { api } from "../lib/api.js";
import { hero, siteContent } from "../lib/content.js";
import {
  avatar,
  chip,
  confirmDialog,
  empty,
  field,
  frag,
  h,
  icon,
  input,
  lightbox,
  meter,
  modal,
  panel,
  select,
  sparkline,
  stat,
  toast,
} from "../lib/dom.js";
import { t } from "../lib/i18n.js";
import { formatPower, powerInput, powerSum, readPowerForm } from "../lib/power.js";
import { canManage } from "../lib/store.js";
import { importDialog } from "./roster-import.js";

const SQUADS = ["AIR", "TANK", "MISSILE"];

function squadOptions() {
  return SQUADS.map((squad) => ({ value: squad, label: t(`squad.${squad}`) }));
}

/** Total power per reading date, for the trend sparkline. */
function totalsSeries(history) {
  if (!history?.length) return [];
  const byMoment = new Map();
  for (const point of history) {
    const key = String(point.at).slice(0, 16);
    const bucket = byMoment.get(key) ?? { AIR: 0, TANK: 0, MISSILE: 0 };
    bucket[point.squad] = point.power;
    byMoment.set(key, bucket);
  }
  return [...byMoment.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, bucket]) => bucket.AIR + bucket.TANK + bucket.MISSILE);
}

export default async function squadsView({ rerender }) {
  const [data, content] = await Promise.all([api.get("roster"), siteContent()]);
  const manage = canManage() && data.canManage;
  const players = data.players;
  const mine = players.find((player) => player.id === data.myPlayerId) ?? null;
  const topPower = players.reduce((max, player) => Math.max(max, player.totalPower), 0);

  /* ----------------------------------------------------------- my squads --- */

  function mySquadsForm() {
    if (!mine) return empty(t("squads.empty"), t("squads.mineNote"));

    const inputs = {
      AIR: powerInput(mine.power.AIR),
      TANK: powerInput(mine.power.TANK),
      MISSILE: powerInput(mine.power.MISSILE),
    };
    const thpInput = powerInput(mine.thp);
    const mainSelect = select({ value: mine.mainSquad }, squadOptions());
    const total = h("strong", { class: "mono", text: formatPower(mine.totalPower) });

    const recompute = () => {
      const sum = powerSum(Object.values(inputs));
      total.textContent = formatPower(sum);
    };
    for (const node of Object.values(inputs)) node.addEventListener("input", recompute);

    const save = h("button", { class: "btn btn--primary", type: "submit" }, icon("check"), t("common.save"));

    return h(
      "form",
      {
        class: "form",
        onSubmit: async (event) => {
          event.preventDefault();
          save.disabled = true;
          try {
            await api.patch("roster/mine", {
              mainSquad: mainSelect.value,
              ...readPowerForm({ air: inputs.AIR, tank: inputs.TANK, missile: inputs.MISSILE, thp: thpInput }),
            });
            toast(t("common.saved"), "ok");
            await rerender();
          } catch (error) {
            toast(error.message, "error");
            save.disabled = false;
          }
        },
      },
      h(
        "div",
        { class: "form form--inline" },
        field(t("squads.airPower"), inputs.AIR, t("power.hint")),
        field(t("squads.tankPower"), inputs.TANK),
        field(t("squads.missilePower"), inputs.MISSILE),
      ),
      h(
        "div",
        { class: "form form--inline" },
        field(t("squad.main"), mainSelect),
        field(t("squads.thpLong"), thpInput, t("squads.thpNote")),
      ),
      h("div", { class: "row" }, h("span", { class: "muted", text: `${t("squads.total")}: ` }), total),
      h("div", { class: "row row--end" }, save),
    );
  }

  /* ------------------------------------------------------- player editor --- */

  function playerDialog(player) {
    const nameInput = input({ type: "text", value: player?.name ?? "", maxlength: 30, required: true });
    const rankSelect = select({ value: player?.rank ?? "R3" }, [
      { value: "R4", label: t("role.R4") },
      { value: "R3", label: t("role.R3") },
    ]);
    const mainSelect = select({ value: player?.mainSquad ?? "AIR" }, squadOptions());
    const inputs = {
      AIR: powerInput(player?.power.AIR ?? 0),
      TANK: powerInput(player?.power.TANK ?? 0),
      MISSILE: powerInput(player?.power.MISSILE ?? 0),
    };
    const thpInput = powerInput(player?.thp ?? 0);

    modal({
      title: player ? t("squads.editPlayer") : t("squads.addPlayer"),
      body: h(
        "div",
        { class: "form" },
        field(t("squads.name"), nameInput),
        h(
          "div",
          { class: "form form--inline" },
          field(t("squads.rank"), rankSelect),
          field(t("squad.main"), mainSelect),
        ),
        h(
          "div",
          { class: "form form--inline" },
          field(t("squads.airPower"), inputs.AIR, t("power.hint")),
          field(t("squads.tankPower"), inputs.TANK),
          field(t("squads.missilePower"), inputs.MISSILE),
        ),
        field(t("squads.thpLong"), thpInput, t("squads.thpNote")),
      ),
      actions: (close) => [
        h("button", { class: "btn btn--ghost", type: "button", onClick: close }, t("common.cancel")),
        h(
          "button",
          {
            class: "btn btn--primary",
            type: "button",
            onClick: async (event) => {
              const button = event.currentTarget;
              button.disabled = true;
              const payload = {
                name: nameInput.value.trim(),
                rank: rankSelect.value,
                mainSquad: mainSelect.value,
                ...readPowerForm({ air: inputs.AIR, tank: inputs.TANK, missile: inputs.MISSILE, thp: thpInput }),
              };
              try {
                if (player) await api.patch("roster", { id: player.id, ...payload });
                else await api.post("roster", payload);
                close();
                toast(t("common.saved"), "ok");
                await rerender();
              } catch (error) {
                toast(error.message, "error");
                button.disabled = false;
              }
            },
          },
          t("common.save"),
        ),
      ],
    });
  }

  async function removePlayer(player) {
    const confirmed = await confirmDialog({
      title: t("squads.deleteTitle"),
      message: t("squads.deleteBody", { name: player.name }),
      confirmLabel: t("common.remove"),
    });
    if (!confirmed) return;
    try {
      await api.del(`roster?id=${player.id}`);
      toast(t("common.deleted"), "ok");
      await rerender();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  function progressDialog(player) {
    const series = totalsSeries(data.history[player.id]);
    modal({
      title: t("squads.playerProgress", { name: player.name }),
      body: h(
        "div",
        { class: "stack" },
        series.length > 1 ? sparkline(series) : h("p", { class: "muted", text: t("squads.progressEmpty") }),
        h(
          "div",
          { class: "grid grid--stats" },
          ...SQUADS.map((squad) =>
            stat({ label: t(`squad.${squad}`), value: formatPower(player.power[squad]) }),
          ),
          stat({ label: t("squads.thpLong"), value: formatPower(player.thp) }),
        ),
      ),
    });
  }

  /* -------------------------------------------------------------- roster --- */

  function rosterTable() {
    if (!players.length) {
      return empty(
        t("squads.empty"),
        manage ? t("squads.emptyManage") : undefined,
        manage
          ? h(
              "div",
              { class: "row row--tight" },
              h(
                "button",
                { class: "btn btn--primary", type: "button", onClick: () => playerDialog(null) },
                icon("plus"),
                t("squads.addPlayer"),
              ),
              h(
                "button",
                {
                  class: "btn btn--ghost",
                  type: "button",
                  onClick: () => importDialog({ onDone: rerender }),
                },
                icon("sheet"),
                t("squads.import"),
              ),
            )
          : null,
      );
    }

    const ordered = [...players].sort((left, right) => right.totalPower - left.totalPower);

    return h(
      "div",
      { class: "tablewrap" },
      h(
        "table",
        {},
        h(
          "thead",
          {},
          h(
            "tr",
            {},
            h("th", { class: "rank", text: "#" }),
            h("th", { text: t("squads.name") }),
            h("th", { text: t("squads.rank") }),
            h("th", { text: t("squad.main") }),
            h("th", { class: "num", text: t("squads.airPower") }),
            h("th", { class: "num", text: t("squads.tankPower") }),
            h("th", { class: "num", text: t("squads.missilePower") }),
            h("th", { class: "num", text: t("squads.thp") }),
            h("th", { class: "num", text: t("squads.total") }),
            h("th", { class: "actions" }),
          ),
        ),
        h(
          "tbody",
          {},
          ...ordered.map((player, index) =>
            h(
              "tr",
              {},
              h("td", { class: "rank", text: String(index + 1) }),
              h(
                "td",
                { class: "name" },
                h(
                  "div",
                  { class: "row row--tight" },
                  avatar(player.photoUrl, player.name, "sm"),
                  h("span", { text: player.name }),
                  player.id === data.myPlayerId ? chip(t("profile.account"), "relay") : null,
                ),
              ),
              h("td", {}, chip(t(`role.${player.rank}`), player.rank === "R4" ? "signal" : undefined)),
              h(
                "td",
                {},
                chip(t(`squad.${player.mainSquad}`), `squad-${player.mainSquad.toLowerCase()}`),
              ),
              h("td", { class: "num", text: formatPower(player.power.AIR) }),
              h("td", { class: "num", text: formatPower(player.power.TANK) }),
              h("td", { class: "num", text: formatPower(player.power.MISSILE) }),
              h("td", { class: "num", text: formatPower(player.thp) }),
              h(
                "td",
                { class: "num" },
                h("div", { class: "stack" }, h("span", { text: formatPower(player.totalPower) }), meter(topPower ? player.totalPower / topPower : 0)),
              ),
              h(
                "td",
                { class: "actions" },
                h(
                  "div",
                  { class: "row row--tight" },
                  h(
                    "button",
                    {
                      class: "iconbtn",
                      type: "button",
                      "aria-label": t("squads.showProgress"),
                      onClick: () => progressDialog(player),
                    },
                    icon("target"),
                  ),
                  manage
                    ? h(
                        "button",
                        {
                          class: "iconbtn",
                          type: "button",
                          "aria-label": t("common.edit"),
                          onClick: () => playerDialog(player),
                        },
                        icon("edit"),
                      )
                    : null,
                  manage
                    ? h(
                        "button",
                        {
                          class: "iconbtn",
                          type: "button",
                          "aria-label": t("common.delete"),
                          onClick: () => removePlayer(player),
                        },
                        icon("trash"),
                      )
                    : null,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  const mySeries = mine ? totalsSeries(data.history[mine.id]) : [];

  return frag(
    hero(content?.sections ?? {}, "squads", { title: t("squads.title"), body: t("squads.subtitle") }),
    h(
      "div",
      { class: "grid grid--lead" },
      panel({
        title: t("squads.mine"),
        subtitle: t("squads.mineNote"),
        body: mySquadsForm(),
      }),
      panel({
        title: t("squads.progress"),
        subtitle: t("squads.progressNote"),
        body: mine && mySeries.length > 1
          ? h(
              "div",
              { class: "stack" },
              sparkline(mySeries),
              h(
                "div",
                { class: "row" },
                ...SQUADS.map((squad) =>
                  chip(`${t(`squad.${squad}`)} ${formatPower(mine.power[squad])}`, `squad-${squad.toLowerCase()}`),
                ),
              ),
            )
          : h("p", { class: "muted", text: t("squads.progressEmpty") }),
      }),
    ),
    panel({
      title: t("squads.title"),
      subtitle: t("squads.subtitle"),
      actions: manage
        ? h(
            "div",
            { class: "row row--tight" },
            h(
              "button",
              {
                class: "btn btn--ghost btn--small",
                type: "button",
                onClick: () => importDialog({ onDone: rerender }),
              },
              icon("sheet"),
              t("squads.import"),
            ),
            h(
              "button",
              { class: "btn btn--primary btn--small", type: "button", onClick: () => playerDialog(null) },
              icon("plus"),
              t("squads.addPlayer"),
            ),
          )
        : undefined,
      body: rosterTable(),
      flush: players.length > 0,
    }),
  );
}
