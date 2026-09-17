/**
 * Two-step onboarding after invite registration: in-game name, then power stats.
 * The rest of the portal stays closed until this completes.
 */

import { api } from "../lib/api.js";
import { field, fill, h, input, select, toast } from "../lib/dom.js";
import { t } from "../lib/i18n.js";
import { account, loadSession, patchAccount } from "../lib/store.js";

const SQUADS = ["AIR", "TANK", "MISSILE"];

function powerInput(value = 0) {
  return input({ type: "number", min: "0", step: "1", value: String(Math.round(Number(value) || 0)), required: true });
}

export function renderOnboarding({ onDone }) {
  const host = h("div", { class: "gate" });
  const formHost = h("div", { class: "gate__form" });
  host.append(
    h(
      "div",
      { class: "gate__art" },
      h("img", { src: "/twcx-interface.png", alt: "" }),
      h("p", { class: "gate__eyebrow", text: t("onboard.eyebrow") }),
      h("h1", { text: t("onboard.title") }),
      h("p", { class: "gate__lede", text: t("onboard.lede") }),
    ),
    formHost,
  );

  let step = 1;
  let busy = false;
  let playerName = account()?.playerName ?? "";
  const stats = {
    airPower: Number(account()?.playerStats?.airPower) || 0,
    tankPower: Number(account()?.playerStats?.tankPower) || 0,
    missilePower: Number(account()?.playerStats?.missilePower) || 0,
    thp: Number(account()?.playerStats?.thp) || 0,
    mainSquad: account()?.playerStats?.mainSquad || "AIR",
  };

  function draw() {
    busy = false;
    if (step === 1) {
      const nameInput = input({
        type: "text",
        required: true,
        maxlength: 30,
        value: playerName,
        autocomplete: "off",
        autocapitalize: "off",
      });
      const submit = h(
        "button",
        { class: "btn btn--primary btn--wide", type: "submit" },
        t("onboard.next"),
      );
      fill(
        formHost,
        h("p", { class: "muted", text: t("onboard.step", { step: 1, total: 2 }) }),
        h("h2", { text: t("onboard.nameTitle") }),
        h(
          "form",
          {
            class: "form",
            onSubmit: (event) => {
              event.preventDefault();
              const value = nameInput.value.trim();
              if (value.length < 3) {
                toast(t("onboard.nameShort"), "error");
                return;
              }
              playerName = value;
              step = 2;
              draw();
            },
          },
          field(t("gate.playerName"), nameInput, t("gate.playerNameHint")),
          submit,
        ),
      );
      nameInput.focus();
      return;
    }

    const air = powerInput(stats.airPower);
    const tank = powerInput(stats.tankPower);
    const missile = powerInput(stats.missilePower);
    const thp = powerInput(stats.thp);
    const main = select(
      { value: stats.mainSquad },
      SQUADS.map((squad) => ({ value: squad, label: t(`squad.${squad}`) })),
    );
    const submit = h(
      "button",
      { class: "btn btn--primary btn--wide", type: "submit" },
      t("onboard.finish"),
    );
    const back = h(
      "button",
      {
        class: "btn btn--ghost btn--wide",
        type: "button",
        onClick: () => {
          step = 1;
          draw();
        },
      },
      t("common.previous"),
    );

    fill(
      formHost,
      h("p", { class: "muted", text: t("onboard.step", { step: 2, total: 2 }) }),
      h("h2", { text: t("onboard.powerTitle") }),
      h("p", { class: "gate__hint", text: t("onboard.powerNote") }),
      h(
        "form",
        {
          class: "form",
          onSubmit: async (event) => {
            event.preventDefault();
            if (busy) return;
            busy = true;
            submit.disabled = true;
            submit.textContent = t("gate.working");
            try {
              const payload = await api.post("account/onboarding", {
                playerName,
                airPower: Number(air.value) || 0,
                tankPower: Number(tank.value) || 0,
                missilePower: Number(missile.value) || 0,
                thp: Number(thp.value) || 0,
                mainSquad: main.value,
              });
              patchAccount({
                playerName: payload.playerName,
                loginName: payload.loginName,
                onboardingComplete: true,
                playerStats: payload.playerStats,
              });
              await loadSession();
              await onDone();
            } catch (error) {
              toast(error.message, "error");
              busy = false;
              submit.disabled = false;
              submit.textContent = t("onboard.finish");
            }
          },
        },
        field(t("squads.airPower"), air),
        field(t("squads.tankPower"), tank),
        field(t("squads.missilePower"), missile),
        field(t("squads.thpLong"), thp, t("squads.thpNote")),
        field(t("squad.main"), main),
        submit,
        back,
      ),
    );
  }

  draw();
  return host;
}
