/**
 * Minimal DOM builder. Everything user-supplied goes in as text, never as
 * markup, so roster names, meme titles and feedback bodies cannot inject HTML.
 */

import { t } from "./i18n.js";

const SVG_NS = "http://www.w3.org/2000/svg";

function applyProps(node, props) {
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;

    if (key === "class") {
      node.setAttribute("class", Array.isArray(value) ? value.filter(Boolean).join(" ") : value);
    } else if (key === "text") {
      node.textContent = String(value);
    } else if (key === "style" && typeof value === "object") {
      Object.assign(node.style, value);
    } else if (key === "dataset") {
      Object.assign(node.dataset, value);
    } else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "value" || key === "checked" || key === "selected" || key === "disabled") {
      node[key] = value;
    } else if (value === true) {
      node.setAttribute(key, "");
    } else {
      node.setAttribute(key, String(value));
    }
  }
}

function appendChildren(node, children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false || child === true) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** `h("div", { class: "panel" }, child, child)` — props are optional. */
export function h(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props && props.constructor === Object) applyProps(node, props);
  else if (props !== null && props !== undefined) children.unshift(props);
  appendChildren(node, children);
  return node;
}

export function frag(...children) {
  const fragment = document.createDocumentFragment();
  appendChildren(fragment, children);
  return fragment;
}

/** Replaces a node's contents in one pass. */
export function fill(node, ...children) {
  node.replaceChildren();
  appendChildren(node, children);
  return node;
}

/* ---------------------------------------------------------------- icons --- */

const PATHS = {
  home: "M4 11.5 12 4l8 7.5M6 10v10h12V10",
  squads: "M8 11a3.2 3.2 0 1 0 0-6.4A3.2 3.2 0 0 0 8 11ZM2.5 20v-1.6A4.4 4.4 0 0 1 6.9 14h2.2a4.4 4.4 0 0 1 4.4 4.4V20M16 5.2a3 3 0 0 1 0 5.9M17.6 14h.6a4 4 0 0 1 4 4v2",
  storm: "M13 3 5.5 13H11l-1 8 7.5-10.5H12l1-7.5Z",
  calendar: "M4 6.8h16V20H4zM4 6.8V5h16v1.8M8.5 3v3.5M15.5 3v3.5M4 11h16M9.5 14.5h1M13.5 14.5h1M9.5 17.5h1M13.5 17.5h1",
  vs: "M4 4h3l5 6M20 4h-3l-5 6M12 10v5M9 20h6M12 15l-2.5 5M12 15l2.5 5",
  community: "M4 5h16v10H9l-5 4V5ZM8 9h8M8 12h5",
  admin: "M12 3l7.5 3v5.8c0 4.2-3 7.6-7.5 9.2-4.5-1.6-7.5-5-7.5-9.2V6L12 3Zm-2.6 8.6 2.1 2.1 4-4",
  profile: "M12 11.4a3.7 3.7 0 1 0 0-7.4 3.7 3.7 0 0 0 0 7.4ZM4.6 20.5v-1.2a5 5 0 0 1 5-5h4.8a5 5 0 0 1 5 5v1.2",
  logout: "M14.5 7.5V5H5v14h9.5v-2.5M11 12h9.5M17.5 8.5 21 12l-3.5 3.5",
  plus: "M12 5v14M5 12h14",
  edit: "M4 20h4L19.2 8.8a2 2 0 0 0 0-2.8l-1.2-1.2a2 2 0 0 0-2.8 0L4 16v4ZM14.5 6.5l3 3",
  trash: "M5 7h14M9.5 7V4.8h5V7M6.8 7l.8 13h8.8l.8-13M10.5 10.5v6M13.5 10.5v6",
  check: "M5 12.8 9.6 17.4 19 8",
  close: "M6 6l12 12M18 6 6 18",
  bell: "M12 4a5.4 5.4 0 0 0-5.4 5.4c0 4-1.6 5.6-1.6 5.6h14s-1.6-1.6-1.6-5.6A5.4 5.4 0 0 0 12 4ZM10.2 18.4a2 2 0 0 0 3.6 0",
  heart: "M12 19.5S4.5 15 4.5 9.9A3.9 3.9 0 0 1 12 8.3a3.9 3.9 0 0 1 7.5 1.6c0 5.1-7.5 9.6-7.5 9.6Z",
  upload: "M12 16.5V4.5M8 8l4-3.5L16 8M4.5 15.5V19a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1v-3.5",
  download: "M12 4.5v12M8 13l4 3.5 3.99-3.5M4.5 15.5V19a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1v-3.5",
  sheet: "M6 3h8l4 4v14H6V3ZM14 3v4h4M9 12h6M9 15.5h6M9 19h3",
  image: "M4 5.5h16v13H4zM4 15l4.5-4 3.5 3 3-2.5L20 16M15.5 9.5a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4Z",
  left: "M14.5 5 8 12l6.5 7",
  right: "M9.5 5 16 12l-6.5 7",
  refresh: "M20 12a8 8 0 1 1-2.6-5.9M20 4.5V10h-5.4",
  award: "M12 14.5a5.2 5.2 0 1 0 0-10.4 5.2 5.2 0 0 0 0 10.4ZM8.8 13.8 7.5 21l4.5-2.4L16.5 21l-1.3-7.2",
  clock: "M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17ZM12 7.4V12l3.4 2.1",
  users: "M8.5 11a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8ZM2 20v-1.6A4.6 4.6 0 0 1 6.6 13.8h3.8A4.6 4.6 0 0 1 15 18.4V20M17 4.6a3.2 3.2 0 0 1 0 6.3",
  target: "M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17ZM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 13.2a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4Z",
  flag: "M6 21V4h11l-1.6 3.8L17 11.6H6",
};

/** Inline stroke icon. Decorative by default — labels live in the markup. */
export function icon(name) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", PATHS[name] ?? PATHS.target);
  svg.append(path);
  return svg;
}

/* --------------------------------------------------------------- toasts --- */

const toastHost = () => document.getElementById("toasts");

export function toast(message, tone = "info") {
  const host = toastHost();
  if (!host) return;
  const node = h("div", { class: ["toast", tone === "error" && "toast--error", tone === "ok" && "toast--ok"] }, message);
  host.append(node);
  setTimeout(() => {
    node.style.transition = "opacity .25s, transform .25s";
    node.style.opacity = "0";
    node.style.transform = "translateX(14px)";
    setTimeout(() => node.remove(), 260);
  }, tone === "error" ? 5200 : 3000);
}

/* ---------------------------------------------------------------- modal --- */

let closeActiveModal = null;

/**
 * Opens a modal. `build(close)` returns the body content; `actions` returns
 * the footer buttons. Resolves when the modal closes.
 */
export function modal({ title, body, actions, wide = false, onClose }) {
  const overlay = document.getElementById("overlay");
  if (!overlay) return () => {};

  closeActiveModal?.();

  const close = () => {
    overlay.hidden = true;
    overlay.replaceChildren();
    document.removeEventListener("keydown", onKey);
    closeActiveModal = null;
    onClose?.();
  };

  function onKey(event) {
    if (event.key === "Escape") close();
  }

  const dialog = h(
    "div",
    { class: ["modal", wide && "modal--wide"], role: "dialog", "aria-modal": "true", "aria-label": title },
    h(
      "div",
      { class: "modal__head" },
      h("h2", { text: title }),
      h("button", { class: "iconbtn", type: "button", "aria-label": t("common.close"), onClick: close }, icon("close")),
    ),
    h("div", { class: "modal__body" }, typeof body === "function" ? body(close) : body),
    actions ? h("div", { class: "modal__foot" }, actions(close)) : null,
  );

  overlay.replaceChildren(dialog);
  overlay.hidden = false;
  overlay.onclick = (event) => {
    if (event.target === overlay) close();
  };
  document.addEventListener("keydown", onKey);
  closeActiveModal = close;

  dialog.querySelector("input, select, textarea, button.btn--primary")?.focus();
  return close;
}

/** Yes/no confirmation. Resolves true when the member confirms. */
export function confirmDialog({ title, message, confirmLabel = t("common.confirm"), danger = true }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const close = modal({
      title,
      body: h("p", { text: message }),
      onClose: () => finish(false),
      actions: (dismiss) => [
        h("button", { class: "btn btn--ghost", type: "button", onClick: dismiss }, t("common.cancel")),
        h(
          "button",
          {
            class: ["btn", danger ? "btn--danger" : "btn--primary"],
            type: "button",
            onClick: () => {
              finish(true);
              dismiss();
            },
          },
          confirmLabel,
        ),
      ],
    });
    void close;
  });
}

/** Shows a full-size image in a lightbox. */
export function lightbox(src, title) {
  modal({
    title,
    wide: true,
    body: h("div", { class: "lightbox" }, h("img", { src, alt: title, loading: "lazy" })),
  });
}

/* --------------------------------------------------------------- pieces --- */

export function empty(title, message, action) {
  return h(
    "div",
    { class: "empty" },
    h("div", { class: "empty__mark" }),
    h("h3", { text: title }),
    message ? h("p", { text: message }) : null,
    action ?? null,
  );
}

export function skeleton(lines = 3, tall = false) {
  return h(
    "div",
    { class: "skeleton" },
    tall ? h("i", { class: "tall" }) : null,
    ...Array.from({ length: lines }, () => h("i")),
  );
}

export function panel({ title, subtitle, actions, body, quiet = false, flush = false }) {
  return h(
    "section",
    { class: ["panel", quiet && "panel--quiet"] },
    title
      ? h(
          "div",
          { class: "panel__head" },
          h("h2", { text: title }),
          actions ? h("div", { class: "spacer" }) : null,
          ...(actions ? [actions].flat() : []),
          subtitle ? h("p", { text: subtitle }) : null,
        )
      : null,
    h("div", { class: ["panel__body", flush && "panel__body--flush"] }, body),
  );
}

export function stat({ label, value, note, tone }) {
  return h(
    "div",
    { class: ["stat", tone && `stat--${tone}`] },
    h("div", { class: "stat__label", text: label }),
    h("div", { class: "stat__value", text: value }),
    note ? h("div", { class: "stat__note", text: note }) : null,
  );
}

/**
 * Member photo, falling back to the initials so a row never looks broken.
 * `size` is a modifier class: "sm", "lg" or nothing for the roster default.
 */
export function avatar(url, name, size) {
  const initials = String(name ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");

  const node = h("span", { class: ["avatar", size && `avatar--${size}`], title: name ?? "" });
  if (url) {
    node.append(
      h("img", {
        src: url,
        alt: name ?? "",
        loading: "lazy",
        decoding: "async",
        // A deleted photo must not leave a broken image behind.
        onError: (event) => {
          event.currentTarget.remove();
          node.append(h("span", { class: "avatar__initials", text: initials || "?" }));
        },
      }),
    );
  } else {
    node.append(h("span", { class: "avatar__initials", text: initials || "?" }));
  }
  return node;
}

export function chip(label, tone) {
  return h("span", { class: ["chip", tone && `chip--${tone}`], text: label });
}

export function field(label, control, hint) {
  return h(
    "label",
    { class: "field" },
    h("span", { class: "field__label", text: label }),
    control,
    hint ? h("span", { class: "field__hint", text: hint }) : null,
  );
}

/**
 * Visible secret field. Firefox hides or collapses `type="password"` (and any
 * `<label for>` pointing at it) when the password manager takes over the form.
 */
export function secretInput(props = {}) {
  const node = document.createElement("input");
  node.type = "text";
  node.name = props.name || "password";
  node.className = "secret-input";
  node.required = Boolean(props.required);
  node.autocomplete = "off";
  node.spellcheck = false;
  node.placeholder = props.placeholder || "";
  node.setAttribute("autocapitalize", "off");
  node.setAttribute("autocorrect", "off");
  node.setAttribute("data-1p-ignore", "true");
  node.setAttribute("data-lpignore", "true");
  if (props.minlength) node.minLength = Number(props.minlength);
  return node;
}

export function input(props) {
  const node = h("input", { ...props });
  if (props?.type) node.type = props.type;
  return node;
}

export function select(props, options) {
  const node = h("select", { ...props });
  for (const option of options) {
    node.append(h("option", { value: option.value, selected: option.value === props.value, text: option.label }));
  }
  return node;
}

export function meter(ratio, variant) {
  const width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
  return h("div", { class: ["meter", variant && `meter--${variant}`] }, h("i", { style: { width } }));
}

/** Compact SVG sparkline for a series of numbers. */
export function sparkline(values) {
  if (values.length < 2) return h("div", { class: "muted", text: "—" });

  const width = 160;
  const height = 40;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * width;
    const y = height - ((value - min) / span) * (height - 6) - 3;
    return [x, y];
  });

  const line = points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const area = `${line} L${width} ${height} L0 ${height} Z`;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "sparkline");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");

  const fill = document.createElementNS(SVG_NS, "path");
  fill.setAttribute("class", "fill");
  fill.setAttribute("d", area);

  const stroke = document.createElementNS(SVG_NS, "path");
  stroke.setAttribute("d", line);

  svg.append(fill, stroke);
  return svg;
}
