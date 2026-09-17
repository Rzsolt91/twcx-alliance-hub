/**
 * Member settings: profile photo, own squad readings, password, interface
 * language, the time zone every server time is converted into, and the
 * address reminders go to.
 */

import { api } from "../lib/api.js";
import {
  avatar,
  chip,
  field,
  fill,
  h,
  icon,
  input,
  panel,
  select,
  stat,
  toast,
} from "../lib/dom.js";
import {
  ANCHOR_ZONE,
  SERVER_HOURS_BEHIND_ANCHOR,
  dateIn,
  timeIn,
  timezoneOptions,
  viewTick,
  zoneLabel,
} from "../lib/clock.js";
import { LANGUAGES, setLanguage, t } from "../lib/i18n.js";
import { account, patchAccount, session } from "../lib/store.js";

const SQUADS = ["AIR", "TANK", "MISSILE"];
const NUMBER = new Intl.NumberFormat("en-GB");

const fmt = (value) => NUMBER.format(Math.round(Number(value) || 0));

function powerInput(value) {
  return input({ type: "number", min: "0", step: "1", value: String(Math.round(Number(value) || 0)) });
}

export default async function profileView({ rerender, params }) {
  const me = account();
  const dashboard = await api.get("dashboard");
  const root = h("div", { class: "stack" });

  const zoneSelect = select({ value: me.timezone }, timezoneOptions(me.timezone));
  const languageSelect = select(
    { value: me.language },
    LANGUAGES.map((language) => ({ value: language.code, label: language.label })),
  );
  const emailInput = input({ type: "email", maxlength: 140, value: me.notifyEmail ?? me.email ?? "" });
  const discordInput = input({
    type: "text",
    maxlength: 32,
    inputmode: "numeric",
    autocomplete: "off",
    value: me.discordId ?? "",
  });

  if (params?.discord === "connected") toast(t("profile.discordConnected"), "ok");
  if (params?.discord === "denied") toast(t("profile.discordDenied"), "error");
  if (params?.discord === "error") toast(t("profile.discordFailed"), "error");
  if (params?.discord === "signin") toast(t("error.session"), "error");
  if (params?.discord) window.history.replaceState(null, "", "#/profile");

  const preview = h("div", { class: "zones" });
  let tickers = [];

  function drawPreview() {
    for (const stop of tickers) stop();
    tickers = [];
    const zone = zoneSelect.value;
    const cards = [
      { name: t("clock.server"), zone: null, mine: false, server: true },
      { name: zone.replace(/_/g, " "), zone, mine: true, server: false },
      { name: ANCHOR_ZONE.replace(/_/g, " "), zone: ANCHOR_ZONE, mine: false, server: false },
    ];

    fill(
      preview,
      ...cards.map((card) => {
        const time = h("div", { class: "zone__time" });
        const date = h("div", { class: "zone__date" });

        tickers.push(
          viewTick((now) => {
            if (card.server) {
              // Server time is Lisbon minus the fixed offset, resolved per instant.
              const anchor = new Date(now - SERVER_HOURS_BEHIND_ANCHOR * 3_600_000);
              time.textContent = timeIn(ANCHOR_ZONE, anchor);
              date.textContent = dateIn(ANCHOR_ZONE, anchor);
            } else {
              time.textContent = timeIn(card.zone, now);
              date.textContent = dateIn(card.zone, now);
            }
          }),
        );

        return h(
          "div",
          { class: ["zone", card.server && "zone--server", card.mine && "zone--mine"] },
          h("div", { class: "zone__name", text: card.name }),
          time,
          date,
          h("div", {
            class: "muted mono",
            text: card.server ? t("clock.behind", { hours: SERVER_HOURS_BEHIND_ANCHOR }) : zoneLabel(card.zone),
          }),
        );
      }),
    );
  }

  zoneSelect.addEventListener("change", drawPreview);

  async function save(button) {
    button.disabled = true;
    try {
      const updated = await api.patch("profile", {
        timezone: zoneSelect.value,
        language: languageSelect.value,
        notifyEmail: emailInput.value.trim(),
      });
      patchAccount(updated);
      setLanguage(updated.language);
      toast(t("profile.saved"), "ok");
      await rerender();
    } catch (error) {
      toast(error.message, "error");
      button.disabled = false;
    }
  }

  const saveButton = h(
    "button",
    { class: "btn btn--primary", type: "button", onClick: (event) => save(event.currentTarget) },
    icon("check"),
    t("common.save"),
  );

  /* ------------------------------------------------------- profile photo --- */

  function photoPanel() {
    const fileInput = input({
      type: "file",
      accept: "image/png,image/jpeg,image/webp,image/gif,image/avif",
      class: "visually-hidden",
      id: "profile-photo",
    });

    const chooseButton = h(
      "button",
      { class: "btn btn--primary btn--small", type: "button", onClick: () => fileInput.click() },
      icon("upload"),
      t("profile.photoChoose"),
    );

    const removeButton = me.avatarUrl
      ? h(
          "button",
          {
            class: "btn btn--ghost btn--small",
            type: "button",
            onClick: async (event) => {
              const button = event.currentTarget;
              button.disabled = true;
              try {
                patchAccount(await api.del("profile/photo"));
                toast(t("profile.photoRemoved"), "ok");
                await rerender();
              } catch (error) {
                toast(error.message, "error");
                button.disabled = false;
              }
            },
          },
          icon("trash"),
          t("profile.photoRemove"),
        )
      : null;

    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      chooseButton.disabled = true;
      const form = new FormData();
      form.set("photo", file);
      try {
        patchAccount(await api.upload("profile/photo", form));
        toast(t("profile.photoSaved"), "ok");
        await rerender();
      } catch (error) {
        toast(error.message, "error");
        chooseButton.disabled = false;
        fileInput.value = "";
      }
    });

    return panel({
      title: t("profile.photo"),
      subtitle: t("profile.photoNote"),
      body: h(
        "div",
        { class: "photoedit" },
        avatar(me.avatarUrl, me.playerName, "lg"),
        h(
          "div",
          { class: "stack" },
          h("p", { class: "muted", text: me.avatarUrl ? me.playerName : t("profile.noPhoto") }),
          h("div", { class: "row row--tight" }, chooseButton, removeButton),
          fileInput,
        ),
      ),
    });
  }

  /* ------------------------------------------------------------- discord --- */

  function discordPanel() {
    const connected = Boolean(me.discordId);
    const oauth = Boolean(session()?.discordConnectAvailable);
    const name = me.discordUsername || me.discordId;

    async function saveId(button) {
      button.disabled = true;
      try {
        const updated = await api.patch("profile", { discordId: discordInput.value.trim() });
        patchAccount({ discordId: updated.discordId, discordUsername: updated.discordUsername ?? me.discordUsername });
        toast(t("profile.discordSaved"), "ok");
        await rerender();
      } catch (error) {
        toast(error.message, "error");
        button.disabled = false;
      }
    }

    async function disconnect(button) {
      button.disabled = true;
      try {
        patchAccount(await api.post("account/discord/disconnect"));
        toast(t("profile.discordRemoved"), "ok");
        await rerender();
      } catch (error) {
        toast(error.message, "error");
        button.disabled = false;
      }
    }

    return panel({
      title: t("profile.discord"),
      subtitle: t("profile.discordNote"),
      body: h(
        "div",
        { class: "stack" },
        connected
          ? h(
              "div",
              { class: "row" },
              chip(t("profile.discordOn"), "signal"),
              h("strong", { text: name }),
            )
          : h("p", { class: "notice", text: t("profile.discordOff") }),
        h(
          "div",
          { class: "row row--tight" },
          oauth && !connected
            ? h("a", { class: "btn btn--primary", href: "/api/account/discord/connect" }, t("profile.discordConnect"))
            : null,
          connected
            ? h(
                "button",
                { class: "btn btn--ghost", type: "button", onClick: (event) => disconnect(event.currentTarget) },
                t("profile.discordDisconnect"),
              )
            : null,
        ),
        !oauth && !connected ? h("p", { class: "muted", text: t("profile.discordOAuthMissing") }) : null,
        field(t("profile.discordId"), discordInput, t("profile.discordIdHint")),
        h(
          "div",
          { class: "row row--end" },
          h(
            "button",
            { class: "btn btn--ghost btn--small", type: "button", onClick: (event) => saveId(event.currentTarget) },
            t("profile.discordSaveId"),
          ),
        ),
      ),
    });
  }

  function squadsPanel() {
    const current = dashboard.me;
    const inputs = {
      AIR: powerInput(current.power.AIR),
      TANK: powerInput(current.power.TANK),
      MISSILE: powerInput(current.power.MISSILE),
    };
    const thpInput = powerInput(current.thp);
    const mainSelect = select(
      { value: current.mainSquad },
      SQUADS.map((squad) => ({ value: squad, label: t(`squad.${squad}`) })),
    );
    const total = h("strong", { class: "mono", text: fmt(current.totalPower) });

    const recompute = () => {
      total.textContent = fmt(SQUADS.reduce((sum, squad) => sum + (Number(inputs[squad].value) || 0), 0));
    };
    for (const node of Object.values(inputs)) node.addEventListener("input", recompute);

    const submit = h("button", { class: "btn btn--primary", type: "submit" }, icon("check"), t("common.save"));

    const form = h(
      "form",
      {
        class: "form",
        onSubmit: async (event) => {
          event.preventDefault();
          submit.disabled = true;
          try {
            await api.patch("roster/mine", {
              mainSquad: mainSelect.value,
              airPower: Number(inputs.AIR.value) || 0,
              tankPower: Number(inputs.TANK.value) || 0,
              missilePower: Number(inputs.MISSILE.value) || 0,
              thp: Number(thpInput.value) || 0,
            });
            toast(t("profile.squadsSaved"), "ok");
            await rerender();
          } catch (error) {
            toast(error.message, "error");
            submit.disabled = false;
          }
        },
      },
      h(
        "div",
        { class: "form form--inline" },
        field(t("squads.airPower"), inputs.AIR),
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
      h("div", { class: "row row--end" }, submit),
    );

    return panel({ title: t("profile.squads"), subtitle: t("profile.squadsNote"), body: form });
  }

  /* ----------------------------------------------------------- password --- */

  function passwordPanel() {
    const currentInput = input({ type: "password", autocomplete: "current-password", minlength: 8 });
    const nextInput = input({ type: "password", autocomplete: "new-password", minlength: 8, required: true });
    const repeatInput = input({ type: "password", autocomplete: "new-password", minlength: 8, required: true });

    const submit = h(
      "button",
      { class: "btn btn--primary", type: "submit" },
      icon("check"),
      me.hasPassword ? t("profile.changePassword") : t("profile.setPassword"),
    );

    const form = h(
      "form",
      {
        class: "form",
        onSubmit: async (event) => {
          event.preventDefault();
          if (nextInput.value !== repeatInput.value) {
            toast(t("gate.passwordMismatch"), "error");
            return;
          }
          submit.disabled = true;
          try {
            const result = await api.patch("auth/password", {
              currentPassword: currentInput.value,
              password: nextInput.value,
            });
            patchAccount({ hasPassword: true, loginName: result.loginName });
            toast(t("profile.passwordSaved"), "ok");
            await rerender();
          } catch (error) {
            toast(error.message, "error");
            submit.disabled = false;
          }
        },
      },
      me.hasPassword ? field(t("profile.currentPassword"), currentInput) : null,
      field(t("profile.newPassword"), nextInput, t("gate.passwordHint")),
      field(t("profile.repeatPassword"), repeatInput),
      h("div", { class: "row row--end" }, submit),
    );

    return panel({
      title: t("profile.password"),
      subtitle: t("profile.passwordNote"),
      body: h(
        "div",
        { class: "stack" },
        h(
          "p",
          { class: "muted" },
          `${t("profile.loginName")}: `,
          h("b", { class: "mono", text: me.loginName ?? me.playerName.toLowerCase() }),
        ),
        me.loginName ? null : h("p", { class: "notice", text: t("profile.loginNameNone") }),
        form,
        h("p", { class: "muted", text: t("gate.noRecovery") }),
      ),
    });
  }

  fill(
    root,
    h(
      "div",
      { class: "grid--stats" },
      stat({ label: t("profile.role"), value: t(`role.${me.role}`), note: t("profile.roleNote") }),
      stat({ label: t("squads.name"), value: me.playerName || "—" }),
      stat({ label: t("squads.thpLong"), value: fmt(dashboard.me.thp), note: t("squads.thp") }),
      stat({ label: t("profile.timezone"), value: zoneLabel(me.timezone), note: me.timezone.replace(/_/g, " ") }),
    ),
    discordPanel(),
    h("div", { class: "grid--halves" }, photoPanel(), squadsPanel()),
    h(
      "div",
      { class: "grid--halves" },
      panel({
        title: t("profile.title"),
        subtitle: t("profile.subtitle"),
        body: h(
          "div",
          { class: "form" },
          field(t("profile.language"), languageSelect),
          field(t("profile.timezone"), zoneSelect, t("profile.timezoneNote")),
          field(t("profile.notifyEmail"), emailInput),
          h("div", { class: "row row--end" }, saveButton),
        ),
      }),
      passwordPanel(),
    ),
    panel({
      title: t("profile.account"),
      body: h(
        "div",
        { class: "stack" },
        h("p", { class: "mono", text: me.email ?? t("profile.noEmail") }),
        h("div", { class: "row row--tight" }, chip(t(`role.${me.role}`), me.role === "MASTER" ? "signal" : "relay")),
        h("p", { class: "muted", text: t("profile.roleNote") }),
        h("p", { class: "notice", text: t("clock.behind", { hours: SERVER_HOURS_BEHIND_ANCHOR }) }),
      ),
    }),
    panel({ title: t("profile.clockPreview"), subtitle: t("profile.clockPreviewNote"), body: preview }),
  );

  drawPreview();
  return root;
}
