/** Command center: alliance status, next operations and world clocks. */

import { api } from "../lib/api.js";
import { countdown, dateTimeIn, formatServerDate, timeIn, viewTick, zoneLabel } from "../lib/clock.js";
import { siteContent, hero } from "../lib/content.js";
import { chip, empty, frag, h, icon, meter, panel, stat } from "../lib/dom.js";
import { t } from "../lib/i18n.js";
import { canManage, myZone } from "../lib/store.js";

const NUMBER = new Intl.NumberFormat("en-GB");

function power(value) {
  return NUMBER.format(Math.round(Number(value) || 0));
}

function categoryTone(category) {
  if (category === "STORM") return "signal";
  if (category === "VS") return "violet";
  if (category === "GE" || category === "GEW") return "go";
  return "relay";
}

/** One row in the "next operations" list, with a live countdown. */
function entry(item, zone, isNext) {
  const instant = new Date(item.instant);
  const count = h("span", { class: "countdown" });

  const stop = viewTick((now) => {
    const remaining = countdown(instant, now);
    count.textContent = remaining ?? t("common.today");
    if (!remaining) stop();
  });

  return h(
    "div",
    { class: ["entry", isNext && "entry--next"] },
    h(
      "div",
      { class: "entry__when" },
      h("div", { class: "entry__day", text: formatServerDate(item.date).split(" ")[0] }),
      h("div", { class: "entry__time", text: item.serverTime }),
      h("div", { class: "entry__date", text: formatServerDate(item.date, { weekday: false }) }),
    ),
    h(
      "div",
      { class: "entry__main" },
      h("div", { class: "entry__title", text: item.title }),
      h(
        "div",
        { class: "entry__meta" },
        h("span", {}, `${t("calendar.inYourZone")} `, h("b", { text: dateTimeIn(zone, instant) })),
      ),
    ),
    h(
      "div",
      { class: "entry__aside" },
      chip(t(`calendar.category.${item.category}`), categoryTone(item.category)),
      count,
    ),
  );
}

/** Server clock plus the member's own zone, side by side. */
function zoneBoard(zone) {
  const cards = [
    { name: t("clock.server"), zone: "Europe/Lisbon", shift: -3, variant: "server" },
    { name: `${t("clock.local")} · ${zone.replace(/_/g, " ")}`, zone, variant: "mine" },
    { name: t("clock.anchor"), zone: "Europe/Lisbon" },
    { name: "Seoul", zone: "Asia/Seoul" },
    { name: "New York", zone: "America/New_York" },
    { name: "São Paulo", zone: "America/Sao_Paulo" },
    { name: "UTC", zone: "UTC" },
  ];

  const nodes = cards.map((card) => {
    const time = h("div", { class: "zone__time", text: "--:--" });
    const date = h("div", { class: "zone__date" });
    viewTick((now) => {
      const at = now.getTime() + (card.shift ?? 0) * 3_600_000;
      time.textContent = timeIn(card.zone, at);
      date.textContent = `${formatServerDate(new Date(at).toISOString().slice(0, 10), { weekday: false })} · ${
        card.shift ? "server" : zoneLabel(card.zone, at)
      }`;
    });
    return h(
      "div",
      { class: ["zone", card.variant && `zone--${card.variant}`] },
      h("div", { class: "zone__name", text: card.name }),
      time,
      date,
    );
  });

  return h("div", { class: "zones" }, ...nodes);
}

function squadSplit(split, players) {
  const rows = ["AIR", "TANK", "MISSILE"].map((squad) => {
    const count = Number(split[squad] ?? 0);
    return h(
      "div",
      { class: "stack" },
      h(
        "div",
        { class: "row" },
        chip(t(`squad.${squad}`), `squad-${squad.toLowerCase()}`),
        h("span", { class: "muted mono", text: `${count}` }),
      ),
      meter(players ? count / players : 0, squad.toLowerCase()),
    );
  });
  return h("div", { class: "stack" }, ...rows);
}

export default async function homeView({ navigate }) {
  const [data, content] = await Promise.all([api.get("dashboard"), siteContent()]);
  const zone = myZone();
  const sections = content?.sections ?? {};

  const statsPanel = panel({
    title: t("home.subtitle"),
    body: h(
      "div",
      { class: "grid grid--stats" },
      stat({
        label: t("home.myPower"),
        value: power(data.me.totalPower),
        note: `${t("squad.main")}: ${t(`squad.${data.me.mainSquad}`)}`,
      }),
      stat({ label: t("home.roster"), value: `${data.alliance.players}`, tone: "relay" }),
      stat({ label: t("home.alliancePower"), value: power(data.alliance.totalPower), tone: "relay" }),
      stat({
        label: t("home.applications"),
        value: `${data.me.applications}`,
        note: t("events.title"),
        tone: data.me.applications ? "go" : undefined,
      }),
      data.openReports !== null
        ? stat({
            label: t("home.openReports"),
            value: `${data.openReports}`,
            tone: data.openReports ? "alert" : undefined,
          })
        : null,
    ),
  });

  const upcomingPanel = panel({
    title: t("home.upcoming"),
    subtitle: t("clock.allTimes"),
    actions: h(
      "button",
      { class: "btn btn--ghost btn--small", type: "button", onClick: () => navigate("calendar") },
      icon("calendar"),
      t("nav.calendar"),
    ),
    body: data.upcoming.length
      ? h("div", { class: "stack" }, ...data.upcoming.map((item, index) => entry(item, zone, index === 0)))
      : empty(t("home.upcomingEmpty"), t("clock.allTimes")),
  });

  const vsPanel = panel({
    title: t("home.vsWeek"),
    subtitle: t("common.week", { date: formatServerDate(data.vs.weekStart, { year: true }) }),
    actions: h(
      "button",
      { class: "btn btn--ghost btn--small", type: "button", onClick: () => navigate("vs") },
      icon("vs"),
      t("nav.vs"),
    ),
    body: data.vs.weekType
      ? h(
          "div",
          { class: "stack" },
          h(
            "div",
            { class: "row" },
            chip(t(`vs.type.${data.vs.weekType}`), data.vs.weekType === "PUSH" ? "signal" : "relay"),
            data.vs.opponent ? chip(`${t("home.vsOpponent")}: ${data.vs.opponent}`, "violet") : null,
          ),
          h(
            "div",
            { class: "grid grid--stats" },
            stat({ label: t("home.vsPoints"), value: power(data.vs.alliancePoints) }),
            stat({ label: t("home.myPoints"), value: power(data.vs.myPoints), tone: "relay" }),
          ),
        )
      : empty(t("home.noVs"), canManage() ? t("vs.noWeekManage") : undefined),
  });

  const sidePanel = panel({
    title: t("home.squadSplit"),
    body: frag(
      squadSplit(data.alliance.squadSplit, data.alliance.players),
      data.topMeme
        ? h(
            "div",
            { class: "notice" },
            h("strong", { text: `${t("home.topMeme")}: ` }),
            `${data.topMeme.title} — ${t("community.likes", { count: data.topMeme.likes })} (${data.topMeme.author})`,
          )
        : null,
    ),
  });

  const clocksPanel = panel({
    title: t("home.zones"),
    subtitle: t("home.zonesNote"),
    body: zoneBoard(zone),
  });

  return frag(
    hero(sections, "home", { title: t("home.title"), body: t("clock.allTimes") }),
    statsPanel,
    h("div", { class: "grid grid--lead" }, upcomingPanel, h("div", { class: "grid" }, vsPanel, sidePanel)),
    clocksPanel,
  );
}
