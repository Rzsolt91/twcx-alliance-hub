/**
 * Access screen.
 *
 * Members sign in with their in-game name and a password — the alliance has no
 * use for email addresses. Accounts created with Netlify Identity before that
 * existed keep their email sign-in, including the reset link, behind a toggle.
 * Registration also collects the time zone every server-time conversion uses.
 */

import {
  login as identityLogin,
  requestPasswordRecovery,
  updateUser,
} from "@netlify/identity";

import { api } from "../lib/api.js";
import { detectTimezone, serverWallClock, timeIn, timezoneOptions } from "../lib/clock.js";
import { field, fill, h, input, modal, select, toast } from "../lib/dom.js";
import { authMessage } from "../lib/identity.js";
import { LANGUAGES, setLanguage, t } from "../lib/i18n.js";

const PENDING_KEY = "twcx:pending-prefs";

/**
 * Firefox's password manager hides `input[type=password]` and `name=password`.
 * This is a plain text box with inline styles so the control cannot collapse.
 */
function visibleSecret(labelText) {
  const wrap = document.createElement("div");
  wrap.setAttribute("class", "field");
  wrap.style.cssText = "display:block;width:100%;min-height:72px;";

  const cap = document.createElement("div");
  cap.textContent = labelText;
  cap.style.cssText =
    "display:block;font:10px/1.2 'IBM Plex Mono',monospace;letter-spacing:.16em;text-transform:uppercase;color:#75848f;margin:0 0 6px;";

  const inp = document.createElement("input");
  inp.type = "text";
  inp.autocomplete = "off";
  inp.spellcheck = false;
  inp.required = true;
  inp.minLength = 8;
  inp.setAttribute("autocapitalize", "off");
  inp.style.cssText =
    "display:block;box-sizing:border-box;width:100%;height:44px;padding:0 12px;border:1px solid #3a4a55;border-radius:3px;background:#12181d;color:#e6ecef;font:16px/44px Consolas,monospace;";

  wrap.append(cap, inp);
  return { wrap, inp };
}

/** Preferences captured at registration, applied once the session exists. */
export function takePendingPreferences() {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(PENDING_KEY);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function storePendingPreferences(prefs) {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode — the member can set these in profile instead */
  }
}

function artPanel() {
  const server = serverWallClock();
  return h(
    "div",
    { class: "gate__art" },
    h("img", { src: "/twcx-interface.png", alt: "" }),
    h("p", { class: "gate__eyebrow", text: t("gate.eyebrow") }),
    h("h1", { text: t("app.name") }),
    h("p", {
      class: "gate__lede",
      text: "Roster power, storm signups, VS weeks and the alliance calendar — one portal, every clock aligned to server time.",
    }),
    h(
      "div",
      { class: "gate__ticks" },
      h("span", {}, `${t("clock.server")} `, h("b", { text: server.time })),
      h("span", {}, `${t("clock.anchor")} `, h("b", { text: timeIn("Europe/Lisbon", Date.now()) })),
      h("span", { text: t("clock.behind", { hours: 3 }) }),
    ),
  );
}

/* --------------------------------------------------------------- the gate --- */

export function renderGate({ notice, onSignedIn }) {
  const host = h("div", { class: "gate" }, artPanel());
  const formHost = h("div", { class: "gate__form" });
  host.append(formHost);

  /** "player" uses our own credentials; "email" falls back to Identity. */
  let channel = "player";
  let mode = "signin";
  let busy = false;
  /** Null until `GET /api/auth/bootstrap` answers; true once anyone exists. */
  let hasAccounts = null;

  const languagePicker = () =>
    h(
      "div",
      { class: "tabs" },
      ...LANGUAGES.map((language) =>
        h(
          "button",
          {
            type: "button",
            "aria-selected": String(document.documentElement.lang === language.code),
            onClick: () => {
              setLanguage(language.code);
              draw();
            },
          },
          language.label,
        ),
      ),
    );

  function title() {
    if (mode === "register") return t("gate.registerTitle");
    return t("gate.signinTitle");
  }

  function draw(message = notice) {
    const register = mode === "register";
    const zone = detectTimezone();

    const nameInput = input({
      type: "text",
      name: "player",
      required: true,
      maxlength: 30,
      autocomplete: "off",
      autocapitalize: "off",
    });
    const emailInput = input({ type: "email", name: "email", required: true, autocomplete: "off" });
    const pass = visibleSecret(t("gate.password"));
    const passAgain = visibleSecret(t("gate.repeatPassword"));
    const passwordInput = pass.inp;
    const repeatInput = passAgain.inp;
    const zoneSelect = select({ name: "timezone", value: zone }, timezoneOptions(zone));
    const languageSelect = select(
      { name: "language", value: document.documentElement.lang === "ko" ? "ko" : "en" },
      LANGUAGES.map((language) => ({ value: language.code, label: language.label })),
    );

    const submit = h(
      "button",
      { class: "btn btn--primary btn--wide", type: "submit", disabled: busy },
      busy ? t("gate.working") : register ? t("gate.registerAction") : t("gate.signinAction"),
    );

    const playerFields = [field(t("gate.playerName"), nameInput, t("gate.signinHint")), pass.wrap];

    const emailFields = register
      ? [field(t("gate.email"), emailInput), pass.wrap, passAgain.wrap]
      : [field(t("gate.email"), emailInput), pass.wrap];

    /** Player name or email against our own endpoints. */
    async function submitPlayer() {
      if (register) {
        if (passwordInput.value !== repeatInput.value) throw new Error(t("gate.passwordMismatch"));
        await api.post("auth/register", {
          email: emailInput.value.trim(),
          password: passwordInput.value,
          timezone: zoneSelect.value,
          language: languageSelect.value,
        });
        setLanguage(languageSelect.value);
      } else {
        await api.post("auth/login", {
          playerName: nameInput.value.trim(),
          password: passwordInput.value,
        });
      }
      await onSignedIn();
    }

    /** Email sign-in (native session); Identity is only used for the rare recovery link. */
    async function submitEmail() {
      if (register) {
        if (passwordInput.value !== repeatInput.value) throw new Error(t("gate.passwordMismatch"));
        await api.post("auth/register", {
          email: emailInput.value.trim(),
          password: passwordInput.value,
          timezone: zoneSelect.value,
          language: languageSelect.value,
        });
        setLanguage(languageSelect.value);
        await onSignedIn();
        return;
      }

      try {
        await api.post("auth/login", {
          email: emailInput.value.trim(),
          password: passwordInput.value,
        });
        await onSignedIn();
      } catch (error) {
        if (error?.status !== 401) throw error;
        await identityLogin(emailInput.value.trim(), passwordInput.value);
        await onSignedIn();
      }
    }

    const form = h(
      "form",
      {
        class: "form",
        autocomplete: "off",
        onSubmit: async (event) => {
          event.preventDefault();
          if (busy) return;
          busy = true;
          submit.disabled = true;
          submit.textContent = t("gate.working");
          try {
            if (channel === "player") await submitPlayer();
            else await submitEmail();
          } catch (error) {
            toast(authMessage(error), "error");
            busy = false;
            draw();
          }
        },
      },
      ...(channel === "player" ? playerFields : emailFields),
      submit,
    );

    const switchMode =
      hasAccounts === false
        ? h(
            "button",
            {
              class: "btn btn--ghost btn--small",
              type: "button",
              onClick: () => {
                mode = register ? "signin" : "register";
                channel = "email";
                busy = false;
                draw();
              },
            },
            register ? t("gate.toSignin") : t("gate.toRegister"),
          )
        : null;

    const switchChannel = register
      ? null
      : h(
          "button",
          {
            class: "btn btn--ghost btn--small",
            type: "button",
            onClick: () => {
              channel = channel === "player" ? "email" : "player";
              busy = false;
              draw();
            },
          },
          channel === "player" ? t("gate.withEmail") : t("gate.withPlayerName"),
        );

    const forgot =
      channel === "email" && !register
        ? h(
            "button",
            {
              class: "btn btn--ghost btn--small",
              type: "button",
              onClick: () => askRecovery(emailInput.value.trim()),
            },
            t("gate.forgot"),
          )
        : null;

    const hint =
      channel === "email"
        ? t("gate.emailNote")
        : hasAccounts === false
          ? t("gate.firstAccount")
          : t("join.useInvite");

    fill(
      formHost,
      languagePicker(),
      h("h2", { text: title() }),
      message ? h("p", { class: "notice notice--relay", text: message }) : null,
      form,
      hint ? h("p", { class: "gate__hint", text: hint }) : null,
      h("div", { class: "row" }, switchMode, forgot, switchChannel),
    );
    formHost.querySelector("input")?.focus();
  }

  function askRecovery(prefill) {
    const emailInput = input({ type: "email", value: prefill, required: true, autocomplete: "email" });
    modal({
      title: t("gate.forgot"),
      body: h(
        "div",
        { class: "form" },
        field(t("gate.email"), emailInput),
        h("p", { class: "muted", text: t("gate.noRecovery") }),
      ),
      actions: (close) => [
        h("button", { class: "btn btn--ghost", type: "button", onClick: close }, t("common.cancel")),
        h(
          "button",
          {
            class: "btn btn--primary",
            type: "button",
            onClick: async () => {
              if (!emailInput.value.trim()) return;
              try {
                await requestPasswordRecovery(emailInput.value.trim());
                close();
                draw(t("gate.recoverySent"));
              } catch (error) {
                toast(authMessage(error), "error");
              }
            },
          },
          t("common.confirm"),
        ),
      ],
    });
  }

  draw();

  // An empty portal has to invite the first Master to register rather than
  // ask them to sign in, so the hint is refreshed as soon as the API answers.
  void api
    .get("auth/bootstrap")
    .then((payload) => {
      hasAccounts = Boolean(payload?.hasAccounts);
      // Only the empty-portal case changes what is on screen, so a slow reply
      // never wipes out what the member has already typed.
      if (!hasAccounts) {
        mode = "register";
        channel = "email";
        draw();
      }
    })
    .catch(() => {
      /* the gate works without the hint */
    });

  return host;
}

/* --------------------------------------------------------------- join --- */

/**
 * Invite-link registration. Email + password only; the in-game name and power
 * stats are collected on the next screen after the session cookie is set.
 */
export function renderJoin({ invite = "", onSignedIn, onSignInInstead }) {
  const host = h("div", { class: "gate" }, artPanel());
  const formHost = h("div", { class: "gate__form" });
  host.append(formHost);

  let busy = false;
  let inviteRequired = true;
  const prefill = String(invite ?? "").trim();

  const languagePicker = () =>
    h(
      "div",
      { class: "tabs" },
      ...LANGUAGES.map((language) =>
        h(
          "button",
          {
            type: "button",
            "aria-selected": String(document.documentElement.lang === language.code),
            onClick: () => {
              setLanguage(language.code);
              draw();
            },
          },
          language.label,
        ),
      ),
    );

  function draw(message) {
    const emailInput = input({
      type: "email",
      required: true,
      autocomplete: "off",
      maxlength: 140,
    });
    const pass = visibleSecret(t("gate.password"));
    const passAgain = visibleSecret(t("gate.repeatPassword"));
    const inviteInput = input({
      type: "text",
      value: prefill,
      maxlength: 32,
      autocomplete: "off",
      autocapitalize: "off",
      required: inviteRequired,
    });
    const submit = h(
      "button",
      { class: "btn btn--primary btn--wide", type: "submit", disabled: busy },
      busy ? t("gate.working") : t("gate.registerAction"),
    );

    fill(
      formHost,
      languagePicker(),
      h("h2", { text: t("join.title") }),
      message ? h("p", { class: "notice notice--relay", text: message }) : null,
      inviteRequired
        ? h("p", { class: "gate__hint", text: prefill ? t("join.inviteReady") : t("join.inviteNeeded") })
        : h("p", { class: "gate__hint", text: t("gate.firstAccount") }),
      h(
        "form",
        {
          class: "form",
          autocomplete: "off",
          onSubmit: async (event) => {
            event.preventDefault();
            if (busy) return;
            if (pass.inp.value !== passAgain.inp.value) {
              toast(t("gate.passwordMismatch"), "error");
              return;
            }
            if (inviteRequired && !inviteInput.value.trim()) {
              toast(t("join.inviteNeeded"), "error");
              return;
            }
            busy = true;
            submit.disabled = true;
            submit.textContent = t("gate.working");
            try {
              const timezone = detectTimezone();
              const language = document.documentElement.lang === "ko" ? "ko" : "en";
              storePendingPreferences({ timezone, language });
              await api.post("auth/register", {
                email: emailInput.value.trim(),
                password: pass.inp.value,
                inviteCode: inviteInput.value.trim(),
                timezone,
                language,
              });
              setLanguage(language);
              await onSignedIn();
            } catch (error) {
              toast(authMessage(error), "error");
              busy = false;
              draw();
            }
          },
        },
        field(t("gate.email"), emailInput),
        pass.wrap,
        passAgain.wrap,
        field(t("join.invite"), inviteInput, t("join.inviteHint")),
        submit,
      ),
      h(
        "div",
        { class: "row" },
        h(
          "button",
          { class: "btn btn--ghost btn--small", type: "button", onClick: onSignInInstead },
          t("gate.toSignin"),
        ),
      ),
    );
    formHost.querySelector("input")?.focus();
  }

  draw();

  void api
    .get("auth/bootstrap")
    .then((payload) => {
      inviteRequired = Boolean(payload?.inviteRequired ?? payload?.hasAccounts);
      draw();
    })
    .catch(() => {
      /* the form still works; the API will reject a missing invite */
    });

  return host;
}

/* ------------------------------------------------------- password recovery --- */

export function renderRecovery({ onDone }) {
  const passwordInput = input({ type: "password", required: true, minlength: 8, autocomplete: "new-password" });
  const submit = h("button", { class: "btn btn--primary btn--wide", type: "submit" }, t("gate.newPasswordAction"));

  const form = h(
    "form",
    {
      class: "form",
      onSubmit: async (event) => {
        event.preventDefault();
        submit.disabled = true;
        submit.textContent = t("gate.working");
        try {
          await updateUser({ password: passwordInput.value });
          toast(t("gate.passwordSaved"), "ok");
          onDone();
        } catch (error) {
          toast(authMessage(error), "error");
          submit.disabled = false;
          submit.textContent = t("gate.newPasswordAction");
        }
      },
    },
    field(t("gate.password"), passwordInput, t("gate.passwordHint")),
    submit,
  );

  return h(
    "div",
    { class: "gate" },
    artPanel(),
    h("div", { class: "gate__form" }, h("h2", { text: t("gate.newPassword") }), form),
  );
}
