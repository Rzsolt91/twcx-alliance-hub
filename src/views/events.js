/**
 * Storm operations: the weekly Canyon and Desert slots, signups per occurrence,
 * team building and published strategies. Every clock shown is server time,
 * with the member's own zone next to it.
 */

import { api } from "../lib/api.js";
import { fileUrl, hero, siteContent } from "../lib/content.js";
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
  lightbox,
  modal,
  panel,
  select,
  toast,
} from "../lib/dom.js";
import {
  countdown,
  dateTimeIn,
  formatServerDate,
  instantFromServerClock,
  signupDeadlineDate,
  signupIsOpen,
  stormKindFromEvent,
  viewTick,
  weekdayNames,
} from "../lib/clock.js";
import { t } from "../lib/i18n.js";
import { myZone } from "../lib/store.js";
import { uploadDialog } from "../lib/upload.js";

const SQUADS = ["AIR", "TANK", "MISSILE"];
const NUMBER = new Intl.NumberFormat("en-GB");

function weekdayOptions() {
  return weekdayNames().map((label, index) => ({ value: String(index), label }));
}

export default async function eventsView({ rerender }) {
  const [data, content] = await Promise.all([api.get("events"), siteContent()]);
  const zone = myZone();
  const manage = data.canManage;

  const signupsFor = (eventId, date) =>
    data.signups.filter((row) => row.weeklyEventId === eventId && row.occurrenceDate === date);
  const teamsFor = (eventId, date) =>
    data.teams.filter((row) => row.weeklyEventId === eventId && row.occurrenceDate === date);

  /* ------------------------------------------------------------- signups --- */

  function applyDialog(event, date, existing) {
    const kind = stormKindFromEvent(event.title, event.weekday);
    if (!signupIsOpen(date, kind)) {
      toast(t("events.signupClosedBody"), "error");
      return;
    }
    if (!event.active) {
      toast(t("events.inactive"), "error");
      return;
    }
    const squadSelect = select(
      { value: existing?.squad ?? data.myMainSquad ?? SQUADS[0] },
      SQUADS.map((squad) => ({ value: squad, label: t(`squad.${squad}`) })),
    );
    const teamSelect = select(
      { value: existing?.stormTeam ?? "BOTH" },
      [
        { value: "A", label: t("events.stormTeam.A") },
        { value: "B", label: t("events.stormTeam.B") },
        { value: "BOTH", label: t("events.stormTeam.BOTH") },
      ],
    );
    const noteInput = input({ type: "text", maxlength: 200, value: existing?.note ?? "" });

    modal({
      title: `${event.title} · ${formatServerDate(date)} ${event.serverTime}`,
      body: h(
        "div",
        { class: "form" },
        h("p", {
          class: "notice notice--relay",
          text: `${t("calendar.inYourZone")}: ${dateTimeIn(zone, instantFromServerClock(date, event.serverTime))}`,
        }),
        field(t("events.yourSquad"), squadSelect),
        field(t("events.stormTeam"), teamSelect, t("events.stormTeamNote")),
        field(`${t("events.note")} (${t("common.optional")})`, noteInput),
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
                await api.post("events/signup", {
                  weeklyEventId: event.id,
                  occurrenceDate: date,
                  squad: squadSelect.value,
                  stormTeam: teamSelect.value,
                  note: noteInput.value.trim(),
                });
                close();
                toast(t("events.applied"), "ok");
                await rerender();
              } catch (error) {
                toast(error.message, "error");
                clickEvent.currentTarget.disabled = false;
              }
            },
          },
          t("events.apply"),
        ),
      ],
    });
  }

  async function withdraw(signup) {
    try {
      await api.del(`events/signup?id=${signup.id}`);
      toast(t("events.withdraw"), "ok");
      await rerender();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function review(signup, status) {
    try {
      await api.patch("events/signup", { id: signup.id, status });
      await rerender();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  function applicantTable(event, date, past) {
    const rows = signupsFor(event.id, date);
    if (!rows.length) return empty(t("events.noApplicants"));

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
            h("th", { text: t("squads.name") }),
            h("th", { text: t("events.yourSquad") }),
            h("th", { text: t("events.stormTeam") }),
            h("th", { class: "num", text: t("squads.total") }),
            h("th", { text: t("events.status.APPLIED") }),
            h("th", { text: t("events.note") }),
            manage ? h("th", { class: "actions" }) : null,
          ),
        ),
        h(
          "tbody",
          {},
          ...rows.map((row) =>
            h(
              "tr",
              {},
              h("td", { class: "name", text: row.playerName }),
              h("td", {}, chip(t(`squad.${row.squad}`), `squad-${String(row.squad).toLowerCase()}`)),
              h("td", {}, chip(t(`events.stormTeam.${row.stormTeam || "BOTH"}`))),
              h("td", { class: "num", text: NUMBER.format(row.power) }),
              h(
                "td",
                {},
                chip(
                  t(`events.status.${row.status}`),
                  row.status === "APPROVED" ? "go" : row.status === "REJECTED" ? "alert" : undefined,
                ),
              ),
              h("td", { class: "muted", text: row.note || "—" }),
              manage
                ? h(
                    "td",
                    { class: "actions" },
                    h(
                      "div",
                      { class: "row row--tight" },
                      past
                        ? null
                        : h(
                            "button",
                            {
                              class: "iconbtn",
                              type: "button",
                              "aria-label": t("events.approve"),
                              onClick: () => review(row, "APPROVED"),
                            },
                            icon("check"),
                          ),
                      past
                        ? null
                        : h(
                            "button",
                            {
                              class: "iconbtn",
                              type: "button",
                              "aria-label": t("events.reject"),
                              onClick: () => review(row, "REJECTED"),
                            },
                            icon("close"),
                          ),
                      h(
                        "button",
                        {
                          class: "iconbtn",
                          type: "button",
                          "aria-label": t("common.remove"),
                          onClick: () => withdraw(row),
                        },
                        icon("trash"),
                      ),
                    ),
                  )
                : null,
            ),
          ),
        ),
      ),
    );
  }

  /* --------------------------------------------------------------- teams --- */

  function teamDialog(event, date, team) {
    const nameInput = input({ type: "text", maxlength: 60, value: team?.teamName ?? "", required: true });
    const notesInput = h("textarea", { maxlength: 1000 }, team?.notes ?? "");
    const applicants = signupsFor(event.id, date);
    const picked = new Set(team?.members ?? []);

    const list = applicants.length
      ? h(
          "div",
          { class: "stack" },
          ...applicants.map((row) =>
            h(
              "label",
              { class: "field field--check" },
              input({
                type: "checkbox",
                checked: picked.has(row.playerName),
                onChange: (changeEvent) => {
                  if (changeEvent.currentTarget.checked) picked.add(row.playerName);
                  else picked.delete(row.playerName);
                },
              }),
              h("span", { text: `${row.playerName} · ${t(`squad.${row.squad}`)} · ${NUMBER.format(row.power)}` }),
            ),
          ),
        )
      : h("p", { class: "muted", text: t("events.noApplicants") });

    modal({
      title: team ? t("events.editTeam") : t("events.buildTeam"),
      body: h(
        "div",
        { class: "form" },
        field(t("events.teamName"), nameInput),
        field(t("events.teamMembers"), list, t("events.membersHint")),
        field(t("events.teamNotes"), notesInput),
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
                await api.post("events/teams", {
                  id: team?.id,
                  weeklyEventId: event.id,
                  occurrenceDate: date,
                  teamName: nameInput.value.trim(),
                  members: [...picked],
                  notes: notesInput.value.trim(),
                });
                close();
                toast(t("common.saved"), "ok");
                await rerender();
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

  async function removeTeam(team) {
    const confirmed = await confirmDialog({
      title: t("common.delete"),
      message: team.teamName,
      confirmLabel: t("common.delete"),
    });
    if (!confirmed) return;
    try {
      await api.del(`events/teams?id=${team.id}`);
      toast(t("common.deleted"), "ok");
      await rerender();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  function teamList(event, date) {
    const teams = teamsFor(event.id, date);
    if (!teams.length) return h("p", { class: "muted", text: t("events.teamsEmpty") });

    return h(
      "div",
      { class: "stack" },
      ...teams.map((team) =>
        h(
          "div",
          { class: "entry" },
          h(
            "div",
            { class: "entry__when" },
            h("div", { class: "entry__day", text: t("events.teams") }),
            h("div", { class: "entry__time", text: String(team.members.length) }),
          ),
          h(
            "div",
            { class: "entry__main" },
            h("div", { class: "entry__title", text: team.teamName }),
            h("div", { class: "entry__meta", text: team.members.join(" · ") || t("common.none") }),
            team.notes ? h("p", { class: "muted", text: team.notes }) : null,
          ),
          manage
            ? h(
                "div",
                { class: "entry__aside" },
                h(
                  "button",
                  { class: "iconbtn", type: "button", "aria-label": t("common.edit"), onClick: () => teamDialog(event, date, team) },
                  icon("edit"),
                ),
                h(
                  "button",
                  { class: "iconbtn", type: "button", "aria-label": t("common.delete"), onClick: () => removeTeam(team) },
                  icon("trash"),
                ),
              )
            : null,
        ),
      ),
    );
  }

  /* ---------------------------------------------------------- slot editor --- */

  function slotDialog(event) {
    const titleInput = input({ type: "text", maxlength: 80, value: event?.title ?? "", required: true });
    const daySelect = select({ value: String(event?.weekday ?? 4) }, weekdayOptions());
    const timeInput = input({ type: "time", value: event?.serverTime ?? "12:00", required: true });
    const descInput = h("textarea", { maxlength: 600 }, event?.description ?? "");
    const activeInput = input({ type: "checkbox", checked: event ? event.active : true });

    modal({
      title: event ? t("events.editSlot") : t("events.addSlot"),
      body: h(
        "div",
        { class: "form" },
        field(t("calendar.eventTitle"), titleInput),
        h(
          "div",
          { class: "form form--inline" },
          field(t("events.weekday"), daySelect),
          field(t("events.serverTime"), timeInput, t("clock.allTimes")),
        ),
        field(t("events.description"), descInput),
        event ? h("label", { class: "field field--check" }, activeInput, h("span", { text: t("events.active") })) : null,
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
                weekday: Number(daySelect.value),
                serverTime: timeInput.value,
                description: descInput.value.trim(),
              };
              try {
                if (event) await api.patch("events", { id: event.id, ...payload, active: activeInput.checked });
                else await api.post("events", payload);
                close();
                toast(t("common.saved"), "ok");
                await rerender();
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

  async function removeSlot(event) {
    const confirmed = await confirmDialog({
      title: t("events.deleteSlot"),
      message: t("events.deleteSlotBody", { title: event.title }),
      confirmLabel: t("common.delete"),
    });
    if (!confirmed) return;
    try {
      await api.del(`events?id=${event.id}`);
      toast(t("common.deleted"), "ok");
      await rerender();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  /* ---------------------------------------------------------- slot panels --- */

  function slotPanel(event) {
    const dates = manage ? [...event.upcoming, ...event.past] : event.upcoming;
    let selected = event.upcoming[0];

    const body = h("div", { class: "stack" });
    let stopTick = null;

    function draw() {
      const past = !event.upcoming.includes(selected);
      const instant = instantFromServerClock(selected, event.serverTime);
      const mine = signupsFor(event.id, selected).find((row) => row.playerId === data.myPlayerId);
      const total = signupsFor(event.id, selected).length;
      const kind = stormKindFromEvent(event.title, event.weekday);
      const deadlineDate = signupDeadlineDate(selected, kind);
      const signupOpen = !past && signupIsOpen(selected, kind);
      const deadlineCopy = t("events.signupCloses", {
        when: formatServerDate(deadlineDate, { year: false }),
      });

      const dateSelect = select(
        { value: selected },
        dates.map((date) => ({
          value: date,
          label: `${formatServerDate(date, { year: false })} · ${event.serverTime}${
            event.past.includes(date) ? ` (${t("events.history")})` : ""
          }`,
        })),
      );
      dateSelect.addEventListener("change", () => {
        selected = dateSelect.value;
        draw();
      });

      const count = h("span", { class: "countdown" });
      stopTick?.();
      stopTick = null;
      if (!past) {
        stopTick = viewTick((now) => {
          const remaining = countdown(instant, now);
          count.textContent = remaining ?? t("common.today");
          if (!remaining) stopTick?.();
          if (signupOpen && !signupIsOpen(selected, kind, now)) {
            stopTick?.();
            draw();
          }
        });
      }

      fill(
        body,
        h(
          "div",
          { class: ["entry", !past && "entry--next"] },
          h(
            "div",
            { class: "entry__when" },
            h("div", { class: "entry__day", text: weekdayNames("short")[event.weekday] }),
            h("div", { class: "entry__time", text: event.serverTime }),
            h("div", { class: "entry__date", text: formatServerDate(selected, { weekday: false }) }),
          ),
          h(
            "div",
            { class: "entry__main" },
            h("div", { class: "entry__title", text: event.title }),
            h(
              "div",
              { class: "entry__meta" },
              h("span", {}, `${t("calendar.inYourZone")} `, h("b", { text: dateTimeIn(zone, instant) })),
              h("span", { text: t("events.signupCount", { count: total }) }),
              h("span", { class: "muted", text: deadlineCopy }),
            ),
            event.description ? h("p", { class: "muted", text: event.description }) : null,
          ),
          h(
            "div",
            { class: "entry__aside" },
            count,
            past
              ? chip(t("events.history"), "relay")
              : !event.active
                ? chip(t("events.inactive"), "alert")
                : mine
                  ? h(
                      "button",
                      { class: "btn btn--ghost btn--small", type: "button", onClick: () => withdraw(mine) },
                      icon("close"),
                      t("events.withdraw"),
                    )
                  : signupOpen
                    ? h(
                        "button",
                        {
                          class: "btn btn--primary btn--small",
                          type: "button",
                          onClick: () => applyDialog(event, selected, mine),
                        },
                        icon("check"),
                        t("events.apply"),
                      )
                    : chip(t("events.signupClosed"), "alert"),
          ),
        ),
        h("div", { class: "row" }, field(t("events.pickOccurrence"), dateSelect)),
        h("h3", { text: t("events.applicants") }),
        applicantTable(event, selected, past),
        h(
          "div",
          { class: "row" },
          h("h3", { text: t("events.teams") }),
          h("div", { class: "spacer", style: { flex: "1" } }),
          manage
            ? h(
                "button",
                {
                  class: "btn btn--ghost btn--small",
                  type: "button",
                  onClick: () => teamDialog(event, selected, null),
                },
                icon("plus"),
                t("events.buildTeam"),
              )
            : null,
        ),
        teamList(event, selected),
      );
    }

    draw();

    return panel({
      title: `${event.title} · ${event.serverTime}`,
      subtitle: `${weekdayNames()[event.weekday]} · ${t("clock.server")}`,
      actions: manage
        ? frag(
            h(
              "button",
              { class: "btn btn--ghost btn--small", type: "button", onClick: () => slotDialog(event) },
              icon("edit"),
              t("events.editSlot"),
            ),
            h(
              "button",
              {
                class: "btn btn--ghost btn--small",
                type: "button",
                onClick: () =>
                  uploadDialog({
                    category: "EVENT",
                    eventId: event.id,
                    dialogTitle: t("events.uploadPlan"),
                    onDone: rerender,
                  }),
              },
              icon("upload"),
              t("events.uploadPlan"),
            ),
            h(
              "button",
              {
                class: "btn btn--danger btn--small",
                type: "button",
                onClick: () => removeSlot(event),
              },
              icon("trash"),
              t("events.deleteSlot"),
            ),
          )
        : undefined,
      body,
    });
  }

  /* --------------------------------------------------------------- plans --- */

  function plansPanel() {
    const body = data.plans.length
      ? h(
          "div",
          { class: "plans" },
          ...data.plans.map((plan) =>
            h(
              "button",
              {
                class: "plan",
                type: "button",
                onClick: () => lightbox(fileUrl(plan.id), plan.title),
              },
              h("img", { src: fileUrl(plan.id), alt: plan.title, loading: "lazy" }),
              h(
                "div",
                { class: "plan__body" },
                h("div", { class: "plan__title", text: plan.title }),
                h("div", {
                  class: "plan__meta",
                  text: [plan.author, plan.description].filter(Boolean).join(" · ") || t("events.plans"),
                }),
              ),
            ),
          ),
        )
      : empty(t("events.plansEmpty"), manage ? t("events.uploadPlan") : undefined);

    return panel({
      title: t("events.plans"),
      actions: manage
        ? h(
            "button",
            {
              class: "btn btn--primary btn--small",
              type: "button",
              onClick: () => uploadDialog({ category: "EVENT", dialogTitle: t("events.uploadPlan"), onDone: rerender }),
            },
            icon("upload"),
            t("events.uploadPlan"),
          )
        : undefined,
      body,
    });
  }

  const slots = data.events.filter((event) => event.active || manage);

  return frag(
    hero(content?.sections ?? {}, "events", { title: t("events.title"), body: t("events.subtitle") }),
    manage
      ? h(
          "div",
          { class: "row row--end" },
          h(
            "button",
            { class: "btn btn--relay btn--small", type: "button", onClick: () => slotDialog(null) },
            icon("plus"),
            t("events.addSlot"),
          ),
        )
      : null,
    slots.length ? frag(...slots.map(slotPanel)) : empty(t("events.title"), t("events.addSlot")),
    plansPanel(),
  );
}
