/**
 * Alliance calendar. Manual daily events and the recurring storms share one
 * month grid; every slot is stated in server time with the member's own zone
 * underneath, and reminders can be toggled per event.
 */

import { api } from "../lib/api.js";
import { hero, siteContent } from "../lib/content.js";
import {
  chip,
  confirmDialog,
  empty,
  field,
  fill,
  frag,
  h,
  icon,
  input,
  modal,
  panel,
  select,
  toast,
} from "../lib/dom.js";
import {
  ANCHOR_ZONE,
  SERVER_HOURS_BEHIND_ANCHOR,
  countdown,
  dateTimeIn,
  formatServerDate,
  instantFromServerClock,
  shiftServerDate,
  timeIn,
  viewTick,
  weekdayNames,
} from "../lib/clock.js";
import { t } from "../lib/i18n.js";
import { canManage, myZone, serverToday } from "../lib/store.js";

const CATEGORIES = ["ALLIANCE", "VS", "GE", "GEW", "OTHER_GAME", "OTHER"];

/** `YYYY-MM-DD` → the first day of its month. */
function monthStart(date) {
  return `${date.slice(0, 7)}-01`;
}

function addMonths(date, delta) {
  const [year, month] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1 + delta, 1));
  return shifted.toISOString().slice(0, 10);
}

function monthLabel(date) {
  const [year, month] = date.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, { timeZone: "UTC", month: "long", year: "numeric" }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
}

/** Six weeks of dates starting on the Sunday at or before the 1st. */
function monthMatrix(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  const first = new Date(Date.UTC(year, monthNumber - 1, 1));
  const start = shiftServerDate(month, -first.getUTCDay());
  return Array.from({ length: 42 }, (_, index) => shiftServerDate(start, index));
}

export default async function calendarView() {
  const zone = myZone();
  const manage = canManage();
  let month = monthStart(serverToday());

  const content = await siteContent();
  const root = h("div", { class: "stack" });

  // Countdowns are rebuilt on every redraw, so drop the previous batch first.
  let tickers = [];
  const tick = (listener) => {
    const stop = viewTick(listener);
    tickers.push(stop);
    return stop;
  };
  const dropTickers = () => {
    for (const stop of tickers) stop();
    tickers = [];
  };

  /* ------------------------------------------------------------- editing --- */

  function eventDialog(entry) {
    const titleInput = input({ type: "text", maxlength: 120, value: entry?.title ?? "", required: true });
    const dateInput = input({ type: "date", value: entry?.date ?? serverToday(), required: true });
    const timeInput = input({ type: "time", value: (entry?.serverTime ?? "12:00").slice(0, 5), required: true });
    const categorySelect = select(
      { value: entry?.category ?? "ALLIANCE" },
      CATEGORIES.map((category) => ({ value: category, label: t(`calendar.category.${category}`) })),
    );
    const descInput = h("textarea", { maxlength: 1500 }, entry?.description ?? "");
    const preview = h("p", { class: "notice notice--relay" });

    function drawPreview() {
      if (!dateInput.value || !timeInput.value) {
        preview.textContent = t("clock.allTimes");
        return;
      }
      const instant = instantFromServerClock(dateInput.value, timeInput.value);
      preview.textContent = `${t("calendar.inYourZone")}: ${dateTimeIn(zone, instant)}`;
    }
    dateInput.addEventListener("change", drawPreview);
    timeInput.addEventListener("change", drawPreview);
    drawPreview();

    modal({
      title: entry ? t("calendar.editEvent") : t("calendar.addEvent"),
      body: h(
        "div",
        { class: "form" },
        field(t("calendar.eventTitle"), titleInput),
        h(
          "div",
          { class: "form form--inline" },
          field(t("calendar.date"), dateInput),
          field(t("events.serverTime"), timeInput, t("clock.allTimes")),
        ),
        field(t("calendar.category"), categorySelect),
        field(t("events.description"), descInput),
        preview,
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
              const payload = {
                title: titleInput.value.trim(),
                date: dateInput.value,
                serverTime: timeInput.value,
                category: categorySelect.value,
                description: descInput.value.trim(),
              };
              try {
                if (entry) await api.patch("calendar", { id: entry.id, ...payload });
                else await api.post("calendar", payload);
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

  /**
   * Deletes a one-off calendar event, or — for a storm occurrence — the whole
   * recurring slot behind it, since a single week of a weekly storm cannot be
   * removed on its own.
   */
  async function removeEvent(entry) {
    const weekly = entry.kind === "WEEKLY";
    const confirmed = await confirmDialog({
      title: weekly ? t("calendar.deleteStormTitle") : t("calendar.deleteTitle"),
      message: weekly
        ? t("calendar.deleteStormBody", { title: entry.title })
        : t("calendar.deleteBody", { title: entry.title }),
      confirmLabel: t("common.delete"),
    });
    if (!confirmed) return;
    try {
      await api.del(weekly ? `events?id=${entry.id}` : `calendar?id=${entry.id}`);
      toast(t("common.deleted"), "ok");
      await load();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function toggleReminder(entry) {
    try {
      await api.post("calendar/reminder", { kind: entry.kind, eventId: entry.id, on: !entry.reminded });
      entry.reminded = !entry.reminded;
      toast(entry.reminded ? t("calendar.reminded") : t("calendar.remind"), "ok");
      await load();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  /* --------------------------------------------------------------- pieces --- */

  function detailDialog(entry) {
    modal({
      title: entry.title,
      body: h(
        "div",
        { class: "stack" },
        h(
          "div",
          { class: "row row--tight" },
          chip(t(`calendar.category.${entry.category}`), pillTone(entry.category)),
          entry.kind === "WEEKLY" ? chip(t("nav.events"), "signal") : null,
        ),
        h("p", {
          class: "mono",
          text: `${formatServerDate(entry.date, { year: true })} · ${entry.serverTime} ${t("clock.server")}`,
        }),
        h("p", { text: `${t("calendar.inYourZone")}: ${dateTimeIn(zone, entry.instant)}` }),
        h("p", {
          class: "muted",
          text: `${ANCHOR_ZONE.split("/")[1]}: ${dateTimeIn(ANCHOR_ZONE, entry.instant)} · ${t("clock.behind", {
            hours: SERVER_HOURS_BEHIND_ANCHOR,
          })}`,
        }),
        entry.description ? h("p", { text: entry.description }) : null,
        entry.author ? h("p", { class: "muted", text: t("common.by", { name: entry.author }) }) : null,
      ),
      actions: (close) => [
        h(
          "button",
          {
            class: ["btn", entry.reminded ? "btn--relay" : "btn--ghost"],
            type: "button",
            onClick: () => {
              close();
              toggleReminder(entry);
            },
          },
          icon("bell"),
          entry.reminded ? t("calendar.reminded") : t("calendar.remind"),
        ),
        entry.editable
          ? h(
              "button",
              {
                class: "btn btn--ghost",
                type: "button",
                onClick: () => {
                  close();
                  eventDialog(entry);
                },
              },
              icon("edit"),
              t("common.edit"),
            )
          : null,
        entry.deletable
          ? h(
              "button",
              {
                class: "btn btn--danger",
                type: "button",
                onClick: () => {
                  close();
                  removeEvent(entry);
                },
              },
              icon("trash"),
              t("common.delete"),
            )
          : null,
        h("button", { class: "btn btn--primary", type: "button", onClick: close }, t("common.close")),
      ],
    });
  }

  function grid(entries, today) {
    const byDate = new Map();
    for (const entry of entries) {
      if (!byDate.has(entry.date)) byDate.set(entry.date, []);
      byDate.get(entry.date).push(entry);
    }

    const short = weekdayNames("short");
    const cells = monthMatrix(month).map((date) => {
      const dayEntries = byDate.get(date) ?? [];
      return h(
        "div",
        {
          class: [
            "calday",
            !date.startsWith(month.slice(0, 7)) && "calday--outside",
            date === today && "calday--today",
          ],
        },
        h(
          "div",
          { class: "calday__num" },
          h("span", { text: String(Number(date.slice(8, 10))) }),
          dayEntries.length ? h("span", { text: String(dayEntries.length) }) : null,
        ),
        ...dayEntries.map((entry) =>
          h(
            "button",
            {
              class: ["calpill", `calpill--${String(entry.category).toLowerCase()}`],
              type: "button",
              onClick: () => detailDialog(entry),
            },
            h("span", { class: "calpill__time", text: `${entry.serverTime} · ${timeIn(zone, entry.instant)}` }),
            h("span", { class: "calpill__title", text: entry.title }),
          ),
        ),
      );
    });

    return h(
      "div",
      { class: "calgrid" },
      ...short.map((name) => h("div", { class: "calgrid__dow", text: name })),
      ...cells,
    );
  }

  function agenda(entries, today) {
    const upcoming = entries
      .filter((entry) => {
        const ms = Date.parse(entry.instant);
        return Number.isFinite(ms) ? ms >= Date.now() : entry.date >= today;
      })
      .slice(0, 12);
    if (!upcoming.length) return empty(t("calendar.empty"));

    return h(
      "div",
      { class: "stack" },
      ...upcoming.map((entry, index) => {
        const count = h("span", { class: "countdown" });
        let stop = () => {};
        stop = tick((now) => {
          const remaining = countdown(entry.instant, now);
          count.textContent = remaining ?? t("common.today");
          if (!remaining) stop();
        });

        return h(
          "div",
          { class: ["entry", index === 0 && "entry--next"] },
          h(
            "div",
            { class: "entry__when" },
            h("div", { class: "entry__day", text: formatServerDate(entry.date, { weekday: true }) }),
            h("div", { class: "entry__time", text: entry.serverTime }),
            h("div", { class: "entry__date", text: timeIn(zone, entry.instant) }),
          ),
          h(
            "div",
            { class: "entry__main" },
            h("div", { class: "entry__title", text: entry.title }),
            h(
              "div",
              { class: "entry__meta" },
              chip(t(`calendar.category.${entry.category}`), pillTone(entry.category)),
              h("span", { text: dateTimeIn(zone, entry.instant) }),
            ),
          ),
          h(
            "div",
            { class: "entry__aside" },
            count,
            h(
              "button",
              {
                class: "iconbtn",
                type: "button",
                "aria-label": entry.reminded ? t("calendar.reminded") : t("calendar.remind"),
                "aria-pressed": entry.reminded ? "true" : "false",
                onClick: () => toggleReminder(entry),
              },
              icon("bell"),
            ),
          ),
        );
      }),
    );
  }

  /* ----------------------------------------------------------------- draw --- */

  async function load() {
    dropTickers();
    const days = monthMatrix(month);
    const from = days[0];
    const to = days[days.length - 1];
    let data = { entries: [], today: serverToday(), canManage: manage };
    try {
      data = await api.get(`calendar?from=${from}&to=${to}`);
    } catch (error) {
      toast(error.message || t("error.loadFailed"), "error");
    }

    const reminders = (data.entries ?? []).filter((entry) => entry.reminded);
    const entries = data.entries ?? [];
    const today = data.today ?? serverToday();

    fill(
      root,
      hero(content?.sections ?? {}, "calendar", { title: t("calendar.title"), body: t("calendar.subtitle") }),
      h("p", { class: "notice", text: `${t("clock.allTimes")} ${t("clock.behind", { hours: SERVER_HOURS_BEHIND_ANCHOR })}` }),
      panel({
        title: monthLabel(month),
        subtitle: t("calendar.subtitle"),
        actions: frag(
          h(
            "button",
            {
              class: "iconbtn",
              type: "button",
              "aria-label": t("common.previous"),
              onClick: () => {
                month = addMonths(month, -1);
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
                month = monthStart(serverToday());
                load();
              },
            },
            t("common.today"),
          ),
          h(
            "button",
            {
              class: "iconbtn",
              type: "button",
              "aria-label": t("common.next"),
              onClick: () => {
                month = addMonths(month, 1);
                load();
              },
            },
            icon("right"),
          ),
          manage
            ? h(
                "button",
                { class: "btn btn--primary btn--small", type: "button", onClick: () => eventDialog(null) },
                icon("plus"),
                t("calendar.addEvent"),
              )
            : null,
        ),
        body: grid(entries, today),
      }),
      h(
        "div",
        { class: "grid--halves" },
        panel({ title: t("calendar.upcomingList"), body: agenda(entries, today) }),
        panel({
          title: t("calendar.remindersTitle"),
          body: reminders.length
            ? h(
                "div",
                { class: "stack" },
                ...reminders.map((entry) =>
                  h(
                    "div",
                    { class: "entry" },
                    h(
                      "div",
                      { class: "entry__when" },
                      h("div", { class: "entry__day", text: formatServerDate(entry.date) }),
                      h("div", { class: "entry__time", text: entry.serverTime }),
                    ),
                    h(
                      "div",
                      { class: "entry__main" },
                      h("div", { class: "entry__title", text: entry.title }),
                      h("div", { class: "entry__meta", text: dateTimeIn(zone, entry.instant) }),
                    ),
                    h(
                      "div",
                      { class: "entry__aside" },
                      h(
                        "button",
                        {
                          class: "iconbtn",
                          type: "button",
                          "aria-label": t("common.remove"),
                          onClick: () => toggleReminder(entry),
                        },
                        icon("close"),
                      ),
                    ),
                  ),
                ),
              )
            : empty(t("calendar.remindersTitle"), t("calendar.remind")),
        }),
      ),
    );
  }

  await load();
  return root;
}

function pillTone(category) {
  if (category === "STORM") return "signal";
  if (category === "VS") return "violet";
  if (category === "ALLIANCE") return "relay";
  if (category === "GE" || category === "GEW") return "go";
  return undefined;
}
