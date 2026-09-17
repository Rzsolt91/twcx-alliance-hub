/** Shared upload dialog for plans, spreadsheets and site images. */

import { api } from "./api.js";
import { invalidateContent } from "./content.js";
import { field, h, input, modal, toast } from "./dom.js";
import { t } from "./i18n.js";

const ACCEPT = {
  image: "image/png,image/jpeg,image/webp,image/gif,image/avif",
  sheet: ".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv",
};

/**
 * Opens the upload form for one library category. `onDone` runs after a
 * successful upload so the caller can refresh its list.
 */
export function uploadDialog({ category = "EVENT", eventId = null, dialogTitle, onDone }) {
  const kind = category === "EXCEL" ? "sheet" : "image";
  const titleInput = input({ type: "text", maxlength: 140, placeholder: t("admin.fileTitle") });
  const noteInput = h("textarea", { maxlength: 1000, placeholder: t("events.teamNotes") });
  const fileInput = input({ type: "file", required: true, accept: ACCEPT[kind] });

  modal({
    title: dialogTitle ?? t("admin.uploadFile"),
    body: h(
      "div",
      { class: "form" },
      field(t("admin.fileTitle"), titleInput),
      field(`${t("events.description")} (${t("common.optional")})`, noteInput),
      field(t("admin.image"), fileInput, t("admin.maxSize")),
    ),
    actions: (close) => [
      h("button", { class: "btn btn--ghost", type: "button", onClick: close }, t("common.cancel")),
      h(
        "button",
        {
          class: "btn btn--primary",
          type: "button",
          onClick: async (event) => {
            const file = fileInput.files?.[0];
            if (!file) {
              toast(t("admin.uploadFile"), "error");
              return;
            }
            const button = event.currentTarget;
            button.disabled = true;
            const form = new FormData();
            form.set("category", category);
            form.set("title", titleInput.value.trim() || file.name);
            form.set("description", noteInput.value.trim());
            if (eventId) form.set("eventId", String(eventId));
            form.set("file", file);
            try {
              await api.upload("library", form);
              invalidateContent();
              close();
              toast(t("common.saved"), "ok");
              await onDone?.();
            } catch (error) {
              toast(error.message, "error");
              button.disabled = false;
            }
          },
        },
        t("common.upload"),
      ),
    ],
  });
}
