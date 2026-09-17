/**
 * Bulk roster entry for R4 and Master: read players out of an Excel/CSV export
 * or a pasted block of rows, show exactly what would change, then apply it.
 *
 * Both sources go through the same server-side normaliser, so the review table
 * and the final write see identical rows.
 */

import { api } from "../lib/api.js";
import { chip, field, h, icon, input, modal, toast } from "../lib/dom.js";
import { t } from "../lib/i18n.js";

const NUMBER = new Intl.NumberFormat("en-GB");
const fmt = (value) => NUMBER.format(Math.round(Number(value) || 0));

const FIELD_LABELS = () => ({
  name: t("squads.name"),
  rank: t("squads.rank"),
  squad: t("squad.main"),
  air: t("squads.airPower"),
  tank: t("squads.tankPower"),
  missile: t("squads.missilePower"),
  thp: t("squads.thp"),
});

/** Opens the source step: a spreadsheet file or pasted rows. */
export function importDialog({ onDone }) {
  const fileInput = input({
    type: "file",
    accept:
      ".xlsx,.csv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/plain",
  });
  const pasteInput = h("textarea", {
    rows: 6,
    placeholder: "Nightfall\t120000000\t90000000\t80000000\t45000000",
  });

  modal({
    title: t("squads.import"),
    body: h(
      "div",
      { class: "form" },
      h("p", { class: "muted", text: t("squads.importNote") }),
      field(t("squads.importFile"), fileInput),
      field(t("squads.importPaste"), pasteInput, t("squads.manualNote")),
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
            const file = fileInput.files?.[0] ?? null;
            const pasted = pasteInput.value.trim();
            if (!file && !pasted) {
              toast(t("squads.importEmpty"), "error");
              return;
            }

            button.disabled = true;
            try {
              let preview;
              if (file) {
                const form = new FormData();
                form.set("file", file);
                preview = await api.upload("roster/preview", form);
              } else {
                preview = await api.post("roster/preview", { text: pasted });
              }
              if (!preview.rows.length) {
                toast(t("squads.importEmpty"), "error");
                button.disabled = false;
                return;
              }
              close();
              reviewDialog(preview, onDone);
            } catch (error) {
              toast(error.message, "error");
              button.disabled = false;
            }
          },
        },
        icon("sheet"),
        t("squads.importRead"),
      ),
    ],
  });
}

/** Second step: the parsed rows, with a tick box per player. */
function reviewDialog(preview, onDone) {
  const labels = FIELD_LABELS();
  const matched = Object.entries(preview.mapping ?? {})
    .filter(([, column]) => column !== null && column !== undefined)
    .map(([key]) => labels[key] ?? key);

  /** Per-row include state, seeded from what the server judged usable. */
  const chosen = preview.rows.map((row) => !row.skip);
  const summary = h("p", { class: "muted" });
  const apply = h("button", { class: "btn btn--primary", type: "button" });

  function counts() {
    let create = 0;
    let update = 0;
    preview.rows.forEach((row, index) => {
      if (!chosen[index]) return;
      if (row.action === "UPDATE") update += 1;
      else create += 1;
    });
    const skip = chosen.filter((value) => !value).length;
    return { create, update, skip, total: create + update };
  }

  function refresh() {
    const { create, update, skip, total } = counts();
    summary.textContent = t("squads.importSummary", { create, update, skip });
    apply.replaceChildren(icon("check"), document.createTextNode(t("squads.importApply", { count: total })));
    apply.disabled = total === 0;
  }

  const rows = preview.rows.map((row, index) => {
    const tick = input({
      type: "checkbox",
      checked: chosen[index],
      "aria-label": t("squads.include"),
      onChange: (event) => {
        chosen[index] = event.currentTarget.checked;
        refresh();
      },
    });

    return h(
      "tr",
      { class: row.skip ? "import__row--skip" : null },
      h("td", {}, tick),
      h("td", { class: "name", text: row.name || "—" }),
      h(
        "td",
        {},
        chip(t(`squads.action.${row.action}`), row.action === "UPDATE" ? "relay" : row.action === "CREATE" ? "signal" : undefined),
      ),
      h("td", {}, chip(t(`role.${row.rank}`), row.rank === "R4" ? "signal" : undefined)),
      h("td", {}, chip(t(`squad.${row.mainSquad}`), `squad-${row.mainSquad.toLowerCase()}`)),
      h("td", { class: "num", text: fmt(row.airPower) }),
      h("td", { class: "num", text: fmt(row.tankPower) }),
      h("td", { class: "num", text: fmt(row.missilePower) }),
      h("td", { class: "num", text: fmt(row.thp) }),
      h("td", { class: "muted", text: row.issues.join(" · ") }),
    );
  });

  const table = h(
    "div",
    { class: "tablewrap tablewrap--tall" },
    h(
      "table",
      { class: "import__table" },
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          h("th", { text: t("squads.include") }),
          h("th", { text: t("squads.name") }),
          h("th", { text: t("squads.action") }),
          h("th", { text: t("squads.rank") }),
          h("th", { text: t("squad.main") }),
          h("th", { class: "num", text: t("squads.airPower") }),
          h("th", { class: "num", text: t("squads.tankPower") }),
          h("th", { class: "num", text: t("squads.missilePower") }),
          h("th", { class: "num", text: t("squads.thp") }),
          h("th", { text: t("squads.issues") }),
        ),
      ),
      h("tbody", {}, ...rows),
    ),
  );

  modal({
    title: t("squads.importReview"),
    wide: true,
    body: h(
      "div",
      { class: "stack" },
      h(
        "div",
        { class: "row row--tight" },
        preview.sheetName ? chip(t("squads.importSheet", { name: preview.sheetName }), "relay") : null,
        matched.length ? chip(t("squads.importColumns", { list: matched.join(", ") })) : null,
      ),
      preview.usedHeaderRow ? null : h("p", { class: "notice", text: t("squads.importNoHeader") }),
      summary,
      table,
    ),
    actions: (close) => {
      apply.addEventListener("click", async () => {
        const payload = preview.rows
          .filter((row, index) => chosen[index])
          .map((row) => ({
            name: row.name,
            rank: row.rank,
            mainSquad: row.mainSquad,
            airPower: row.airPower,
            tankPower: row.tankPower,
            missilePower: row.missilePower,
            thp: row.thp,
          }));
        if (!payload.length) {
          toast(t("squads.importNothing"), "error");
          return;
        }

        apply.disabled = true;
        try {
          const result = await api.post("roster/import", { rows: payload });
          close();
          toast(t("squads.importDone", result), "ok");
          await onDone?.();
        } catch (error) {
          toast(error.message, "error");
          apply.disabled = false;
        }
      });

      return [h("button", { class: "btn btn--ghost", type: "button", onClick: close }, t("common.cancel")), apply];
    },
  });

  refresh();
}
