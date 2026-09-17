/**
 * VS duel weeks. A week is either a push week or a save week, has one opponent
 * alliance, a published strategy (notes plus an optional image) and the points
 * every player scored.
 */

import { api } from "../lib/api.js";
import { fileUrl, hero, siteContent } from "../lib/content.js";
import {
  chip,
  empty,
  field,
  fill,
  frag,
  h,
  icon,
  input,
  lightbox,
  meter,
  modal,
  panel,
  select,
  stat,
  toast,
} from "../lib/dom.js";
import { formatServerDate, serverWeekStart } from "../lib/clock.js";
import { t } from "../lib/i18n.js";
import { canManage, serverToday } from "../lib/store.js";
import { uploadDialog } from "../lib/upload.js";

const WEEK_TYPES = ["PUSH", "SAVE"];
const NUMBER = new Intl.NumberFormat("en-GB");

export default async function vsView() {
  const manage = canManage();
  let week = serverWeekStart(serverToday());

  const content = await siteContent();
  const root = h("div", { class: "stack" });

  /* ------------------------------------------------------------- editing --- */

  function weekDialog(data, images) {
    const current = data.week;
    const typeSelect = select(
      { value: current?.weekType ?? "PUSH" },
      WEEK_TYPES.map((type) => ({ value: type, label: t(`vs.type.${type}`) })),
    );
    const opponentInput = input({ type: "text", maxlength: 80, value: current?.opponent ?? "" });
    const notesInput = h("textarea", { maxlength: 4000, rows: 6 }, current?.strategyNotes ?? "");

    // Images come from the VS library, loaded with the week so the dialog never
    // has to open a second modal on top of itself.
    const imageSelect = select(
      { value: String(current?.strategyImageId ?? "") },
      [{ value: "", label: t("common.none") }, ...images.map((file) => ({ value: String(file.id), label: file.title }))],
    );

    modal({
      title: `${t("vs.setWeek")} · ${t("common.week", { date: formatServerDate(data.weekStart, { year: true }) })}`,
      body: h(
        "div",
        { class: "form" },
        h("div", { class: "form form--inline" }, field(t("vs.weekType"), typeSelect), field(t("vs.opponent"), opponentInput)),
        field(t("vs.strategyNotes"), notesInput),
        field(t("vs.strategyImage"), imageSelect, t("events.plansEmpty")),
      ),
      actions: (close) => [
        h("button", { class: "btn btn--ghost", type: "button", onClick: close }, t("common.cancel")),
        h(
          "button",
          {
            class: "btn btn--primary",
            type: "button",
            onClick: async (clickEvent) => {
              clickEvent.currentTarget.disabled = true;
              try {
                await api.post("vs", {
                  weekStart: data.weekStart,
                  weekType: typeSelect.value,
                  opponent: opponentInput.value.trim(),
                  strategyNotes: notesInput.value.trim(),
                  strategyImageId: imageSelect.value ? Number(imageSelect.value) : null,
                });
                close();
                toast(t("common.saved"), "ok");
                await load();
              } catch (error) {
                toast(error.message, "error");
                clickEvent.currentTarget.disabled = false;
              }
            },
          },
          t("common.save"),
        ),
      ],
    });
  }

  function pointsDialog(data) {
    const inputs = new Map();
    const rows = data.players.map((player) => {
      const box = input({ type: "number", min: "0", step: "1", value: String(player.points) });
      inputs.set(player.playerId, box);
      return h(
        "tr",
        {},
        h("td", { class: "name", text: player.name }),
        h("td", {}, chip(t(`squad.${player.mainSquad}`), `squad-${String(player.mainSquad).toLowerCase()}`)),
        h("td", { class: "num" }, box),
      );
    });

    modal({
      title: `${t("vs.enterPoints")} · ${t("common.week", { date: formatServerDate(data.weekStart, { year: true }) })}`,
      wide: true,
      body: h(
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
              h("th", { text: t("squads.name") }),
              h("th", { text: t("squad.main") }),
              h("th", { class: "num", text: t("vs.points") }),
            ),
          ),
          h("tbody", {}, ...rows),
        ),
      ),
      actions: (close) => [
        h("button", { class: "btn btn--ghost", type: "button", onClick: close }, t("common.cancel")),
        h(
          "button",
          {
            class: "btn btn--primary",
            type: "button",
            onClick: async (clickEvent) => {
              clickEvent.currentTarget.disabled = true;
              const points = [...inputs.entries()].map(([playerId, box]) => ({
                playerId,
                points: Number(box.value || 0),
              }));
              try {
                await api.post("vs/points", { weekStart: data.weekStart, points });
                close();
                toast(t("vs.pointsSaved"), "ok");
                await load();
              } catch (error) {
                toast(error.message, "error");
                clickEvent.currentTarget.disabled = false;
              }
            },
          },
          t("vs.savePoints"),
        ),
      ],
    });
  }

  /* -------------------------------------------------------------- pieces --- */

  function scoreboard(data) {
    if (!data.players.length) return empty(t("squads.empty"));
    const top = data.players[0]?.points ?? 0;

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
            h("th", { text: t("squad.main") }),
            h("th", { class: "num", text: t("vs.points") }),
            h("th", { text: t("vs.total") }),
          ),
        ),
        h(
          "tbody",
          {},
          ...data.players.map((player, index) =>
            h(
              "tr",
              {},
              h("td", { class: "rank", text: String(index + 1) }),
              h("td", { class: "name", text: player.name }),
              h("td", {}, chip(t(`squad.${player.mainSquad}`), `squad-${String(player.mainSquad).toLowerCase()}`)),
              h("td", { class: "num", text: NUMBER.format(player.points) }),
              h("td", {}, meter(top ? player.points / top : 0, "air")),
            ),
          ),
        ),
      ),
    );
  }

  function strategyPanel(data, images) {
    const body = data.week?.strategyNotes || data.week?.strategyImageId
      ? h(
          "div",
          { class: "stack" },
          data.week.strategyImageId
            ? h(
                "button",
                {
                  class: "plan",
                  type: "button",
                  onClick: () => lightbox(fileUrl(data.week.strategyImageId), data.week.strategyTitle ?? t("vs.strategy")),
                },
                h("img", {
                  src: fileUrl(data.week.strategyImageId),
                  alt: data.week.strategyTitle ?? t("vs.strategy"),
                  loading: "lazy",
                }),
              )
            : null,
          data.week.strategyNotes ? h("p", { text: data.week.strategyNotes }) : null,
        )
      : empty(t("vs.noStrategy"), manage ? t("vs.setWeek") : undefined);

    return panel({
      title: t("vs.strategy"),
      actions: manage
        ? frag(
            h(
              "button",
              {
                class: "btn btn--ghost btn--small",
                type: "button",
                onClick: () =>
                  uploadDialog({ category: "VS", dialogTitle: t("vs.strategyImage"), onDone: load }),
              },
              icon("upload"),
              t("common.upload"),
            ),
            h(
              "button",
              { class: "btn btn--ghost btn--small", type: "button", onClick: () => weekDialog(data, images) },
              icon("edit"),
              t("common.edit"),
            ),
          )
        : undefined,
      body,
    });
  }

  function historyPanel(data) {
    if (!data.weeks.length) return panel({ title: t("vs.history"), body: empty(t("vs.history")) });

    return panel({
      title: t("vs.history"),
      body: h(
        "div",
        { class: "stack" },
        ...data.weeks.map((row) =>
          h(
            "button",
            {
              class: ["entry", row.weekStart === data.weekStart && "entry--next"],
              type: "button",
              style: { width: "100%", textAlign: "left", background: "none", border: "0", font: "inherit", color: "inherit" },
              onClick: () => {
                week = row.weekStart;
                load();
              },
            },
            h(
              "div",
              { class: "entry__when" },
              h("div", { class: "entry__day", text: formatServerDate(row.weekStart, { weekday: false }) }),
              h("div", { class: "entry__time", text: row.weekStart.slice(0, 4) }),
            ),
            h(
              "div",
              { class: "entry__main" },
              h("div", { class: "entry__title", text: row.opponent || t("common.none") }),
              h("div", { class: "entry__meta" }, chip(t(`vs.type.${row.weekType}`), row.weekType === "PUSH" ? "signal" : "relay")),
            ),
          ),
        ),
      ),
    });
  }

  /* ----------------------------------------------------------------- draw --- */

  async function load() {
    const [data, library] = await Promise.all([
      api.get(`vs?week=${week}`),
      manage ? api.get("library?category=VS") : Promise.resolve({ files: [] }),
    ]);
    const images = library.files.filter((file) => file.isImage);
    week = data.weekStart;
    const leader = data.players[0];

    fill(
      root,
      hero(content?.sections ?? {}, "vs", { title: t("vs.title"), body: t("vs.subtitle") }),
      panel({
        title: t("common.week", { date: formatServerDate(data.weekStart, { year: true }) }),
        subtitle: data.week
          ? `${t(`vs.type.${data.week.weekType}`)}${data.week.opponent ? ` · ${data.week.opponent}` : ""}`
          : t("vs.noWeek"),
        actions: frag(
          h(
            "button",
            {
              class: "iconbtn",
              type: "button",
              "aria-label": t("common.previous"),
              onClick: () => {
                week = data.previousWeek;
                load();
              },
            },
            icon("left"),
          ),
          h(
            "button",
            {
              class: "btn btn--ghost btn--small",
              type: "button",
              onClick: () => {
                week = data.currentWeek;
                load();
              },
            },
            t("common.thisWeek"),
          ),
          h(
            "button",
            {
              class: "iconbtn",
              type: "button",
              "aria-label": t("common.next"),
              onClick: () => {
                week = data.nextWeek;
                load();
              },
            },
            icon("right"),
          ),
          manage
            ? h(
                "button",
                { class: "btn btn--relay btn--small", type: "button", onClick: () => weekDialog(data, images) },
                icon("flag"),
                t("vs.setWeek"),
              )
            : null,
          manage
            ? h(
                "button",
                { class: "btn btn--primary btn--small", type: "button", onClick: () => pointsDialog(data) },
                icon("edit"),
                t("vs.enterPoints"),
              )
            : null,
        ),
        body: h(
          "div",
          { class: "grid--stats" },
          stat({
            label: t("vs.weekType"),
            value: data.week ? t(`vs.type.${data.week.weekType}`) : "—",
            note: data.week?.weekType === "SAVE" ? t("vs.type.SAVE") : undefined,
            tone: data.week?.weekType === "SAVE" ? "relay" : "signal",
          }),
          stat({ label: t("vs.opponent"), value: data.week?.opponent || "—" }),
          stat({ label: t("vs.total"), value: NUMBER.format(data.totalPoints) }),
          stat({
            label: t("vs.leader"),
            value: leader && leader.points > 0 ? leader.name : "—",
            note: leader && leader.points > 0 ? NUMBER.format(leader.points) : undefined,
          }),
        ),
      }),
      !data.week
        ? h("p", { class: "notice notice--alert", text: manage ? t("vs.noWeekManage") : t("vs.noWeek") })
        : null,
      h("div", { class: "grid--lead" }, panel({ title: t("vs.scoreboard"), body: scoreboard(data), flush: true }), strategyPanel(data, images)),
      historyPanel(data),
    );
  }

  await load();
  return root;
}
