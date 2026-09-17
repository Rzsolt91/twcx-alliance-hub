/**
 * Session state shared by the shell and the views. Kept in its own module so
 * views never have to import the app entry point (and create a cycle).
 */

import { api } from "./api.js";
import { setLanguage } from "./i18n.js";

const state = {
  /** Payload from `GET /api/session`. */
  session: null,
  route: "home",
  query: {},
  listeners: new Set(),
};

export function session() {
  return state.session;
}

export function account() {
  return state.session?.account ?? null;
}

export function modules() {
  return state.session?.modules ?? ["home"];
}

export function hasModule(name) {
  return modules().includes(name);
}

export function canManage() {
  return Boolean(state.session?.canManage);
}

export function isMaster() {
  return Boolean(state.session?.isMaster);
}

export function needsOnboarding() {
  return account()?.onboardingComplete === false;
}

export function myZone() {
  return state.session?.account?.timezone || "Europe/Lisbon";
}

export function clock() {
  return state.session?.clock ?? null;
}

/** Server `YYYY-MM-DD` as of the last session read, refreshed on navigation. */
export function serverToday() {
  return state.session?.clock?.serverDate ?? new Date().toISOString().slice(0, 10);
}

export async function loadSession() {
  const payload = await api.get("session");
  state.session = payload;
  setLanguage(payload?.account?.language ?? "en");
  notify();
  return payload;
}

export function patchAccount(fields) {
  if (!state.session) return;
  state.session.account = { ...state.session.account, ...fields };
  if (fields.language) setLanguage(fields.language);
  notify();
}

export function clearSession() {
  state.session = null;
  notify();
}

export function route() {
  return state.route;
}

export function query() {
  return state.query;
}

export function setRoute(name, params = {}) {
  state.route = name;
  state.query = params;
}

/** Subscribe to session changes (the rail badge and language both depend on it). */
export function onSessionChange(listener) {
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

function notify() {
  for (const listener of state.listeners) listener(state.session);
}
