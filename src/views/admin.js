/**
 * Administration. Master and R4 manage accounts, site copy, imagery and the
 * file library; only a Master changes roles or decides which sections an R3
 * account may open.
 */

import { api } from "../lib/api.js";
import { fileUrl, hero, invalidateContent, siteContent } from "../lib/content.js";
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
import { t } from "../lib/i18n.js";
import { isMaster, session } from "../lib/store.js";
import { uploadDialog } from "../lib/upload.js";

const LIBRARIES = ["EVENT", "VS", "SITE", "EXCEL"];
const NUMBER = new Intl.NumberFormat("en-GB");

function fileSize(bytes) {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default async function adminView() {
  const master = isMaster();
  let library = "EVENT";
  const root = h("div", { class: "stack" });

  /* -------------------------------------------------------------- accounts --- */

  function accountDialog(data, user) {
    const roleSelect = select(
      { value: user.role, disabled: !data.canEditRoles },
      data.roles.map((role) => ({ value: role, label: t(`role.${role}`) })),
    );

    const boxes = new Map();
    const moduleList = h(
      "div",
      { class: "stack" },
      ...data.modules
        .filter((module) => module !== "home")
        .map((module) => {
          const box = input({
            type: "checkbox",
            checked: user.allowedModules.includes(module),
            disabled: !data.canEditRoles,
          });
          boxes.set(module, box);
          return h("label", { class: "field field--check" }, box, h("span", { text: t(`nav.${module}`) }));
        }),
    );

    function syncModuleState() {
      const r3 = roleSelect.value === "R3";
      moduleList.style.opacity = r3 ? "1" : "0.5";
      for (const box of boxes.values()) box.disabled = !data.canEditRoles || !r3;
    }
    roleSelect.addEventListener("change", syncModuleState);
    syncModuleState();

    modal({
      title: t("admin.editMember"),
      body: h(
        "div",
        { class: "form" },
        h("p", { class: "mono", text: user.email || user.loginName || user.playerName }),
        !data.canEditRoles ? h("p", { class: "notice notice--alert", text: t("admin.masterOnly") }) : null,
        field(t("admin.role"), roleSelect),
        field(t("admin.sections"), moduleList, t("admin.membersNote")),
      ),
      actions: (close) => [
        h("button", { class: "btn btn--ghost", type: "button", onClick: close }, t("common.cancel")),
        data.canEditRoles
          ? h(
              "button",
              {
                class: "btn btn--primary",
                type: "button",
                onClick: async (clickEvent) => {
                  clickEvent.currentTarget.disabled = true;
                  const allowedModules =
                    roleSelect.value === "R3"
                      ? [...boxes.entries()].filter(([, box]) => box.checked).map(([module]) => module)
                      : data.modules;
                  try {
                    await api.patch("admin/users", { id: user.id, role: roleSelect.value, allowedModules });
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
            )
          : null,
      ],
    });
  }

  /**
   * Master-only password reset. A player-name account has no email, so there
   * is no reset link to send — the Master sets one and passes it on.
   */
  function passwordDialog(user) {
    const nextInput = input({ type: "password", minlength: 8, required: true, autocomplete: "new-password" });
    const repeatInput = input({ type: "password", minlength: 8, required: true, autocomplete: "new-password" });

    modal({
      title: t("admin.setPassword"),
      body: h(
        "div",
        { class: "form" },
        h("p", { class: "mono", text: user.playerName || user.email || "—" }),
        h("p", { class: "muted", text: t("admin.setPasswordNote") }),
        field(t("profile.newPassword"), nextInput, t("gate.passwordHint")),
        field(t("profile.repeatPassword"), repeatInput),
      ),
      actions: (close) => [
        h("button", { class: "btn btn--ghost", type: "button", onClick: close }, t("common.cancel")),
        h(
          "button",
          {
            class: "btn btn--primary",
            type: "button",
            onClick: async (event) => {
              if (nextInput.value !== repeatInput.value) {
                toast(t("gate.passwordMismatch"), "error");
                return;
              }
              const button = event.currentTarget;
              button.disabled = true;
              try {
                await api.patch("admin/users/password", { id: user.id, password: nextInput.value });
                close();
                toast(t("admin.setPasswordDone", { name: user.playerName || user.email }), "ok");
                await load();
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

  async function revoke(user) {
    const confirmed = await confirmDialog({
      title: t("admin.revoke"),
      message: t("admin.revokeBody", { name: user.playerName || user.email }),
      confirmLabel: t("admin.revoke"),
    });
    if (!confirmed) return;
    try {
      await api.del(`admin/users?id=${user.id}`);
      toast(t("common.deleted"), "ok");
      await load();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  function accountsPanel(data) {
    return panel({
      title: t("admin.members"),
      subtitle: t("admin.membersNote"),
      flush: true,
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
              h("th", { text: t("admin.role") }),
              h("th", { text: t("admin.sections") }),
              h("th", { class: "num", text: t("squads.total") }),
              h("th", { text: t("profile.timezone") }),
              h("th", { class: "actions" }),
            ),
          ),
          h(
            "tbody",
            {},
            ...data.users.map((user) =>
              h(
                "tr",
                {},
                h(
                  "td",
                  { class: "name" },
                  h("div", {}, user.playerName || "—"),
                  h("div", {
                    class: "muted mono",
                    text: user.loginName
                      ? `${t("admin.loginName")}: ${user.loginName}`
                      : user.email || t("admin.noPassword"),
                  }),
                ),
                h(
                  "td",
                  {},
                  chip(
                    t(`role.${user.role}`),
                    user.role === "MASTER" ? "signal" : user.role === "R4" ? "relay" : undefined,
                  ),
                ),
                h("td", {
                  class: "muted",
                  text:
                    user.role === "R3"
                      ? user.allowedModules
                          .filter((module) => module !== "home")
                          .map((module) => t(`nav.${module}`))
                          .join(", ") || t("common.none")
                      : t("admin.sectionsAll"),
                }),
                h("td", { class: "num", text: user.totalPower === null ? "—" : NUMBER.format(user.totalPower) }),
                h("td", { class: "muted mono", text: user.timezone }),
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
                        "aria-label": t("admin.editMember"),
                        onClick: () => accountDialog(data, user),
                      },
                      icon("edit"),
                    ),
                    master
                      ? h(
                          "button",
                          {
                            class: "iconbtn",
                            type: "button",
                            "aria-label": t("admin.setPassword"),
                            onClick: () => passwordDialog(user),
                          },
                          icon("admin"),
                        )
                      : null,
                    master && !user.isSelf
                      ? h(
                          "button",
                          {
                            class: "iconbtn",
                            type: "button",
                            "aria-label": t("admin.revoke"),
                            onClick: () => revoke(user),
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
      ),
    });
  }

  /* --------------------------------------------------------------- content --- */

  const SECTION_KEYS = ["home", "gate", "events", "calendar", "vs", "community"];

  function contentDialog(sections, images, key) {
    const section = sections[key] ?? null;
    const titleInput = input({ type: "text", maxlength: 140, value: section?.title ?? "" });
    const bodyInput = h("textarea", { maxlength: 4000, rows: 6 }, section?.body ?? "");
    const imageSelect = select(
      { value: String(section?.imageId ?? "") },
      [{ value: "", label: t("common.none") }, ...images.map((file) => ({ value: String(file.id), label: file.title }))],
    );

    modal({
      title: `${t("admin.content")} · ${key}`,
      body: h(
        "div",
        { class: "form" },
        field(t("admin.headline"), titleInput),
        field(t("admin.copy"), bodyInput),
        field(t("admin.image"), imageSelect, t("admin.contentNote")),
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
                await api.patch("content", {
                  section: key,
                  title: titleInput.value.trim(),
                  body: bodyInput.value.trim(),
                  imageId: imageSelect.value ? Number(imageSelect.value) : null,
                });
                invalidateContent();
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

  function contentPanel(content, images) {
    const sections = content.sections ?? {};
    const keys = [...new Set([...SECTION_KEYS, ...Object.keys(sections)])];

    return panel({
      title: t("admin.content"),
      subtitle: t("admin.contentNote"),
      actions: h(
        "button",
        {
          class: "btn btn--ghost btn--small",
          type: "button",
          onClick: () => uploadDialog({ category: "SITE", dialogTitle: t("admin.image"), onDone: load }),
        },
        icon("upload"),
        t("admin.image"),
      ),
      body: h(
        "div",
        { class: "stack" },
        ...keys.map((key) => {
          const section = sections[key] ?? null;
          return h(
            "div",
            { class: "entry" },
            h(
              "div",
              { class: "entry__when" },
              h("div", { class: "entry__day", text: t(`nav.${key}`) !== `nav.${key}` ? t(`nav.${key}`) : key }),
              h("div", { class: "entry__time mono", text: key }),
            ),
            h(
              "div",
              { class: "entry__main" },
              h("div", { class: "entry__title", text: section?.title || "—" }),
              h("p", { class: "muted", text: section?.body || t("admin.copy") }),
              section?.editor
                ? h("div", { class: "entry__meta", text: t("common.by", { name: section.editor }) })
                : null,
            ),
            h(
              "div",
              { class: "entry__aside" },
              section?.imageId
                ? h(
                    "button",
                    {
                      class: "iconbtn",
                      type: "button",
                      "aria-label": t("admin.image"),
                      onClick: () => lightbox(fileUrl(section.imageId), section.title || key),
                    },
                    icon("image"),
                  )
                : null,
              h(
                "button",
                {
                  class: "btn btn--ghost btn--small",
                  type: "button",
                  onClick: () => contentDialog(sections, images, key),
                },
                icon("edit"),
                t("common.edit"),
              ),
            ),
          );
        }),
      ),
    });
  }

  /* --------------------------------------------------------------- library --- */

  async function removeFile(file) {
    const confirmed = await confirmDialog({
      title: t("admin.deleteFile"),
      message: t("admin.deleteFileBody", { title: file.title }),
      confirmLabel: t("common.delete"),
    });
    if (!confirmed) return;
    try {
      await api.del(`library?id=${file.id}`);
      invalidateContent();
      toast(t("common.deleted"), "ok");
      await load();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  function libraryPanel(files) {
    const tabs = h(
      "div",
      { class: "tabs" },
      ...LIBRARIES.map((category) =>
        h(
          "button",
          {
            type: "button",
            "aria-selected": category === library ? "true" : "false",
            onClick: () => {
              library = category;
              load();
            },
          },
          t(`admin.category.${category}`),
        ),
      ),
    );

    return panel({
      title: t("admin.library"),
      subtitle: t("admin.libraryNote"),
      actions: h(
        "button",
        {
          class: "btn btn--primary btn--small",
          type: "button",
          onClick: () =>
            uploadDialog({
              category: library,
              dialogTitle: `${t("admin.uploadFile")} · ${t(`admin.category.${library}`)}`,
              onDone: load,
            }),
        },
        icon("upload"),
        t("admin.uploadFile"),
      ),
      body: h(
        "div",
        { class: "stack" },
        tabs,
        files.length
          ? h(
              "div",
              { class: "stack" },
              ...files.map((file) =>
                h(
                  "div",
                  { class: "filecard" },
                  h("div", { class: "filecard__icon" }, icon(file.isImage ? "image" : "sheet")),
                  h(
                    "div",
                    {},
                    h("div", { text: file.title }),
                    h("div", {
                      class: "muted mono",
                      text: [file.fileName, fileSize(file.sizeBytes), file.author]
                        .filter(Boolean)
                        .join(" · "),
                    }),
                  ),
                  h(
                    "div",
                    { class: "row row--tight" },
                    file.isImage
                      ? h(
                          "button",
                          {
                            class: "iconbtn",
                            type: "button",
                            "aria-label": t("admin.image"),
                            onClick: () => lightbox(fileUrl(file.id), file.title),
                          },
                          icon("image"),
                        )
                      : null,
                    h(
                      "a",
                      {
                        class: "iconbtn",
                        href: `${fileUrl(file.id)}&download=1`,
                        "aria-label": t("common.download"),
                      },
                      icon("download"),
                    ),
                    h(
                      "button",
                      {
                        class: "iconbtn",
                        type: "button",
                        "aria-label": t("common.delete"),
                        onClick: () => removeFile(file),
                      },
                      icon("trash"),
                    ),
                  ),
                ),
              ),
            )
          : empty(t("admin.libraryEmpty"), t("admin.maxSize")),
      ),
    });
  }

  /* ---------------------------------------------------------- invite codes --- */

  function invitesPanel(data) {
    const rows = data?.invites ?? [];
    return panel({
      title: t("admin.invites"),
      subtitle: t("admin.invitesNote"),
      actions: h(
        "button",
        {
          class: "btn btn--primary btn--small",
          type: "button",
          onClick: () => createInvite(),
        },
        icon("plus"),
        t("admin.inviteCreate"),
      ),
      body: rows.length
        ? h(
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
                  h("th", { text: t("admin.inviteCode") }),
                  h("th", { text: t("admin.inviteStatus") }),
                  h("th", { text: t("admin.inviteNote") }),
                  h("th", { class: "actions" }),
                ),
              ),
              h(
                "tbody",
                {},
                ...rows.map((invite) =>
                  h(
                    "tr",
                    {},
                    h("td", { class: "mono", text: invite.code }),
                    h(
                      "td",
                      {},
                      chip(
                        invite.active ? t("admin.inviteActive") : t("admin.inviteRevoked"),
                        invite.active ? "signal" : undefined,
                      ),
                    ),
                    h("td", { class: "muted", text: invite.note || "—" }),
                    h(
                      "td",
                      { class: "actions" },
                      h(
                        "div",
                        { class: "row row--tight" },
                        h(
                          "button",
                          {
                            class: "btn btn--ghost btn--small",
                            type: "button",
                            onClick: async () => {
                              const url = `${window.location.origin}/#/join?invite=${encodeURIComponent(invite.code)}`;
                              try {
                                await navigator.clipboard.writeText(url);
                                toast(t("admin.inviteCopied"), "ok");
                              } catch {
                                toast(url, "ok");
                              }
                            },
                          },
                          t("admin.inviteCopy"),
                        ),
                        h(
                          "button",
                          {
                            class: "btn btn--ghost btn--small",
                            type: "button",
                            onClick: () => toggleInvite(invite),
                          },
                          invite.active ? t("admin.inviteRevoke") : t("admin.inviteRestore"),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          )
        : empty(t("admin.invitesEmpty"), t("admin.invitesNote")),
    });
  }

  function createInvite() {
    const noteInput = input({ type: "text", maxlength: 200, placeholder: t("admin.inviteNoteHint") });
    modal({
      title: t("admin.inviteCreate"),
      body: h("div", { class: "form" }, field(t("admin.inviteNote"), noteInput, t("admin.inviteNoteHint"))),
      actions: (close) => [
        h("button", { class: "btn btn--ghost", type: "button", onClick: close }, t("common.cancel")),
        h(
          "button",
          {
            class: "btn btn--primary",
            type: "button",
            onClick: async (event) => {
              event.currentTarget.disabled = true;
              try {
                await api.post("admin/invite-codes", { note: noteInput.value.trim() });
                close();
                toast(t("common.saved"), "ok");
                await load();
              } catch (error) {
                toast(error.message, "error");
                event.currentTarget.disabled = false;
              }
            },
          },
          t("admin.inviteCreate"),
        ),
      ],
    });
  }

  async function toggleInvite(invite) {
    try {
      await api.patch(`admin/invite-codes/${invite.id}`, { active: !invite.active });
      toast(invite.active ? t("admin.inviteRevokedDone") : t("admin.inviteRestoredDone"), "ok");
      await load();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  /* ------------------------------------------------------------------ draw --- */

  function generatorPanel() {
    const url = session()?.generatorUrl;
    if (!url) return null;
    return panel({
      title: t("admin.generator"),
      subtitle: t("admin.generatorNote"),
      actions: h(
        "a",
        { class: "btn btn--primary", href: `${url.replace(/\/$/, "")}/admin` },
        t("admin.generatorOpen"),
      ),
      body: h("p", { class: "muted", text: t("admin.generatorBody") }),
    });
  }

  async function load() {
    const [users, content, libraryFiles, siteImages, invites] = await Promise.all([
      api.get("admin/users"),
      siteContent({ refresh: true }),
      api.get(`library?category=${library}`),
      api.get("library?category=SITE"),
      api.get("admin/invite-codes"),
    ]);

    const images = siteImages.files.filter((file) => file.isImage);

    fill(
      root,
      hero(content.sections ?? {}, "admin", { title: t("admin.title"), body: t("admin.subtitle") }),
      master ? null : h("p", { class: "notice notice--alert", text: t("admin.masterOnly") }),
      generatorPanel(),
      invitesPanel(invites),
      accountsPanel(users),
      frag(contentPanel(content, images), libraryPanel(libraryFiles.files)),
    );
  }

  await load();
  return root;
}
