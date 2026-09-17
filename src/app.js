/**
 * Portal entry point: Identity bridge, application shell and router.
 */

import { handleAuthCallback, logout, MissingIdentityError, onAuthChange } from "@netlify/identity";

import { ApiError, api } from "./lib/api.js";
import { everySecond, serverWallClock, stopViewTickers, timeIn, zoneLabel } from "./lib/clock.js";
import { avatar, empty, fill, frag, h, icon, skeleton, toast } from "./lib/dom.js";
import { authMessage } from "./lib/identity.js";
import { SERVER_HOURS_BEHIND_ANCHOR } from "../shared/time.ts";
import { setLanguage, t } from "./lib/i18n.js";
import {
  account,
  canManage,
  clearSession,
  hasModule,
  loadSession,
  myZone,
  needsOnboarding,
  onSessionChange,
  patchAccount,
  route,
  setRoute,
} from "./lib/store.js";

import { renderGate, renderJoin, renderRecovery, takePendingPreferences } from "./views/auth.js";
import { renderOnboarding } from "./views/onboarding.js";
import homeView from "./views/home.js";
import squadsView from "./views/squads.js";
import eventsView from "./views/events.js";
import calendarView from "./views/calendar.js";
import vsView from "./views/vs.js";
import communityView from "./views/community.js";
import adminView from "./views/admin.js";
import profileView from "./views/profile.js";

const appHost = document.getElementById("app");

const VIEWS = {
  home: { render: homeView, icon: "home", label: "nav.home", module: "home", group: "operations" },
  events: { render: eventsView, icon: "storm", label: "nav.events", module: "events", group: "operations" },
  calendar: { render: calendarView, icon: "calendar", label: "nav.calendar", module: "calendar", group: "operations" },
  vs: { render: vsView, icon: "vs", label: "nav.vs", module: "vs", group: "operations" },
  squads: { render: squadsView, icon: "squads", label: "nav.squads", module: "squads", group: "alliance" },
  community: { render: communityView, icon: "community", label: "nav.community", module: "community", group: "alliance" },
  admin: { render: adminView, icon: "admin", label: "nav.admin", manage: true, group: "alliance" },
  profile: { render: profileView, icon: "profile", label: "nav.profile", group: "account" },
};

const TABBAR = ["home", "events", "calendar", "vs", "community"];

function isAllowed(name) {
  const entry = VIEWS[name];
  if (!entry) return false;
  if (entry.manage) return canManage();
  if (entry.module) return hasModule(entry.module);
  return true;
}

function allowedRoutes() {
  return Object.keys(VIEWS).filter(isAllowed);
}

/* --------------------------------------------------------------- routing --- */

function parseHash() {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [path, search] = raw.split("?");
  const params = Object.fromEntries(new URLSearchParams(search ?? ""));
  return { name: path || "home", params };
}

export function navigate(name, params = {}) {
  const search = new URLSearchParams(params).toString();
  const target = `#/${name}${search ? `?${search}` : ""}`;
  if (window.location.hash === target) {
    applyRoute();
    return;
  }
  window.location.hash = target;
}

let viewHost = null;
let renderToken = 0;

async function applyRoute() {
  if (needsOnboarding()) {
    showOnboarding();
    return;
  }
  const { name, params } = parseHash();
  const resolved = isAllowed(name) ? name : allowedRoutes()[0] ?? "profile";
  setRoute(resolved, params);
  markActiveNav(resolved);
  await renderCurrentView();
}

async function renderCurrentView() {
  if (!viewHost) return;
  const name = route();
  const entry = VIEWS[name];
  const token = (renderToken += 1);

  stopViewTickers();
  fill(viewHost, loadingLayout());

  try {
    const node = await entry.render({ rerender: renderCurrentView, navigate, params: parseHash().params });
    if (token !== renderToken) return;
    fill(viewHost, node);
    viewHost.scrollTo?.({ top: 0 });
  } catch (error) {
    if (token !== renderToken) return;
    if (error instanceof ApiError && error.status === 401) {
      await signOut();
      return;
    }
    const message = error instanceof ApiError ? error.message : t("error.loadFailed");
    fill(
      viewHost,
      empty(
        t("common.error"),
        message,
        h("button", { class: "btn btn--primary", type: "button", onClick: () => renderCurrentView() }, t("common.retry")),
      ),
    );
    console.error(`view ${name} failed`, error);
  }
}

function loadingLayout() {
  return frag(
    h("div", { class: "panel" }, h("div", { class: "panel__body" }, skeleton(3, true))),
    h("div", { class: "panel" }, h("div", { class: "panel__body" }, skeleton(4))),
  );
}

/* ----------------------------------------------------------------- shell --- */

let stopClock = null;

function markActiveNav(name) {
  for (const node of document.querySelectorAll("[data-route]")) {
    if (node.dataset.route === name) node.setAttribute("aria-current", "page");
    else node.removeAttribute("aria-current");
  }
  const heading = document.getElementById("view-title");
  if (heading) heading.textContent = t(VIEWS[name]?.label ?? "app.name");
}

function navItem(name) {
  const entry = VIEWS[name];
  return h(
    "button",
    { class: "nav__item", type: "button", dataset: { route: name }, onClick: () => navigate(name) },
    icon(entry.icon),
    h("span", { text: t(entry.label) }),
    entry.manage ? h("span", { class: "nav__count", text: t(`role.${account()?.role ?? "R4"}`) }) : null,
  );
}

function navSection(groupName, names) {
  const items = names.filter(isAllowed);
  if (!items.length) return null;
  return frag(h("div", { class: "nav__group", text: t(`nav.group.${groupName}`) }), ...items.map(navItem));
}

function clockCluster() {
  const zone = myZone();
  const serverValue = h("strong", { class: "clocks__value", text: "--:--:--" });
  const localValue = h("strong", { class: "clocks__value", text: "--:--" });
  stopClock?.();
  stopClock = everySecond((now) => {
    const server = serverWallClock(now);
    serverValue.textContent = `${server.time}:${String(now.getSeconds()).padStart(2, "0")}`;
    localValue.textContent = timeIn(zone, now);
    const mobile = document.getElementById("topbar-clock");
    if (mobile) mobile.textContent = server.time;
  });

  return h(
    "div",
    { class: "clocks" },
    h(
      "div",
      { class: "clocks__row clocks__row--server" },
      h("span", { class: "clocks__label", text: t("clock.server") }),
      serverValue,
    ),
    h(
      "div",
      { class: "clocks__row clocks__row--local" },
      h("span", { class: "clocks__label", text: t("clock.local") }),
      localValue,
    ),
    h("p", { class: "clocks__meta", text: `${zone.replace(/_/g, " ")} · ${zoneLabel(zone)}` }),
    h("p", { class: "clocks__meta", text: t("clock.behind", { hours: SERVER_HOURS_BEHIND_ANCHOR }) }),
  );
}

function brand() {
  return h(
    "div",
    { class: "brand" },
    h("span", { class: "brand__mark" }, h("i")),
    h(
      "span",
      {},
      h("span", { class: "brand__name", text: "TWCX" }),
      h("span", { class: "brand__sub", text: t("app.tagline") }),
    ),
  );
}

function railFoot() {
  const me = account();
  return h(
    "div",
    { class: "rail__foot" },
    h(
      "div",
      { class: "whoami" },
      avatar(me?.avatarUrl, me?.playerName, "sm"),
      h(
        "div",
        { class: "whoami__who" },
        h("span", { class: "whoami__name", text: me?.playerName ?? "" }),
        h("span", { class: "whoami__role", text: t(`role.${me?.role ?? "R3"}`) }),
      ),
    ),
    h(
      "button",
      { class: "btn btn--ghost btn--small btn--wide", type: "button", onClick: () => signOut() },
      icon("logout"),
      t("nav.signout"),
    ),
  );
}

function tabbar() {
  const names = TABBAR.filter(isAllowed);
  for (const extra of allowedRoutes()) {
    if (!names.includes(extra) && extra !== "profile") names.push(extra);
  }
  names.push("profile");
  return h(
    "nav",
    { class: "tabbar", "aria-label": t("app.tagline") },
    ...names.map((name) =>
      h(
        "button",
        { type: "button", dataset: { route: name }, onClick: () => navigate(name) },
        icon(VIEWS[name].icon),
        h("span", { text: t(VIEWS[name].label) }),
      ),
    ),
  );
}

function renderShell() {
  viewHost = h("main", { class: "view", id: "content" });

  const shell = h(
    "div",
    { class: "shell" },
    h(
      "aside",
      { class: "rail" },
      brand(),
      clockCluster(),
      h(
        "nav",
        { class: "nav", "aria-label": t("app.tagline") },
        navSection("operations", ["home", "events", "calendar", "vs"]),
        navSection("alliance", ["squads", "community", "admin"]),
        navSection("account", ["profile"]),
      ),
      railFoot(),
    ),
    h(
      "div",
      { class: "main" },
      h(
        "header",
        { class: "topbar" },
        h(
          "div",
          { class: "topbar__title" },
          h("h1", { id: "view-title", text: t("nav.home") }),
          h("p", { text: t("clock.allTimes") }),
        ),
        h("div", { class: "topbar__spacer" }),
        h("span", { class: "topbar__clock mono", id: "topbar-clock", text: "--:--" }),
      ),
      viewHost,
    ),
    tabbar(),
  );

  fill(appHost, shell);
}

/* ------------------------------------------------------------------ auth --- */

export async function signOut() {
  // Either channel may be the live one, so both are torn down.
  try {
    await api.post("auth/logout");
  } catch {
    /* the cookie is cleared by the reply, or was never set */
  }
  try {
    await logout();
  } catch {
    /* the session is gone either way */
  }
  stopClock?.();
  stopClock = null;
  clearSession();
  window.location.hash = "";
  showGate();
}

function showGate(notice) {
  stopClock?.();
  stopClock = null;
  viewHost = null;
  fill(appHost, renderGate({ notice, onSignedIn: enterPortal }));
}

function showJoin(invite) {
  stopClock?.();
  stopClock = null;
  viewHost = null;
  fill(appHost, renderJoin({ invite, onSignedIn: enterPortal, onSignInInstead: () => showGate() }));
}

function showOnboarding() {
  stopClock?.();
  stopClock = null;
  viewHost = null;
  fill(appHost, renderOnboarding({ onDone: () => enterPortal() }));
}

/**
 * Loads the portal session and renders the shell.
 *
 * `firstVisit` keeps the gate quiet when nobody was signed in to begin with —
 * "your session expired" only makes sense after a session existed.
 */
export async function enterPortal({ firstVisit = false } = {}) {
  fill(
    appHost,
    h(
      "div",
      { class: "boot", role: "status" },
      h("div", { class: "boot__reticle" }, h("span"), h("span"), h("span"), h("span")),
      h("p", { class: "boot__label", text: t("app.name") }),
      h("p", { class: "boot__status", text: t("common.loading") }),
    ),
  );
  try {
    await loadSession();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      showGate(firstVisit ? undefined : t("error.session"));
      return;
    }
    fill(
      appHost,
      h(
        "div",
        { class: "boot" },
        empty(
          t("common.error"),
          error instanceof ApiError ? error.message : t("error.loadFailed"),
          h("button", { class: "btn btn--primary", type: "button", onClick: () => enterPortal() }, t("common.retry")),
        ),
      ),
    );
    return;
  }
  await applyPendingPreferences();
  if (needsOnboarding()) {
    showOnboarding();
    return;
  }
  renderShell();
  await applyRoute();
}

/** Applies the time zone and language chosen during registration. */
async function applyPendingPreferences() {
  const pending = takePendingPreferences();
  if (!pending) return;
  try {
    patchAccount(await api.patch("profile", pending));
  } catch {
    /* the member can set these from their profile at any time */
  }
}

/** Rebuilds the shell in place — used when the language or zone changes. */
export async function refreshShell() {
  setLanguage(account()?.language ?? "en");
  renderShell();
  await applyRoute();
}

/* ------------------------------------------------------------------ boot --- */

window.addEventListener("hashchange", () => {
  const { name, params } = parseHash();
  if (needsOnboarding()) {
    showOnboarding();
    return;
  }
  if (!account()) {
    if (name === "join") showJoin(params.invite);
    return;
  }
  if (viewHost) void applyRoute();
});

onSessionChange((current) => {
  if (current) document.documentElement.lang = current.account?.language ?? "en";
});

try {
  onAuthChange((event) => {
    if (event === "logout" && viewHost) {
      clearSession();
      showGate();
    }
  });
} catch {
  /* Identity is optional; player-name sessions do not need it. */
}

async function boot() {
  let callback = null;
  try {
    callback = await handleAuthCallback();
  } catch (error) {
    if (!(error instanceof MissingIdentityError)) toast(authMessage(error), "error");
  }

  if (callback?.type === "recovery") {
    fill(appHost, renderRecovery({ onDone: () => showGate(t("gate.passwordSaved")) }));
    return;
  }

  // `GET /api/session` accepts either credential — our own session cookie or
  // the Identity one — so the portal opens without knowing which was used.
  const { name, params } = parseHash();
  if (name === "join") {
    try {
      await loadSession();
      if (needsOnboarding()) {
        showOnboarding();
        return;
      }
      if (account()) {
        renderShell();
        window.location.hash = "#/home";
        return;
      }
    } catch {
      /* no session yet — fall through to the join form */
    }
    showJoin(params.invite);
    return;
  }

  await enterPortal({ firstVisit: true });
  if (callback?.type === "confirmation") toast(t("gate.confirmed"), "ok");
}

void boot().catch((error) => {
  console.error("boot failed", error);
  showGate(authMessage(error));
});
