/**
 * Editable section copy and images. Master and R4 change these from
 * Administration; every view reads them from one cached fetch.
 */

import { api } from "./api.js";
import { h } from "./dom.js";

let cached = null;

export async function siteContent({ refresh = false } = {}) {
  if (!cached || refresh) cached = await api.get("content").catch(() => ({ sections: {}, canEdit: false }));
  return cached;
}

export function invalidateContent() {
  cached = null;
}

/** URL for an uploaded image or spreadsheet. */
export function fileUrl(id) {
  return `/api/library/file?id=${id}`;
}

/** URL for a community post image. */
export function postUrl(id) {
  return `/api/library/post?id=${id}`;
}

/**
 * Section banner. Falls back to the packaged interface art when no image has
 * been uploaded, and renders nothing when there is no copy to show either.
 */
export function hero(sections, key, { title, body } = {}) {
  const section = sections?.[key] ?? null;
  const heading = section?.title || title;
  const copy = section?.body || body;
  if (!heading && !copy) return null;

  return h(
    "section",
    { class: "hero" },
    h("img", { src: section?.imageId ? fileUrl(section.imageId) : "/twcx-interface.png", alt: "" }),
    heading ? h("h2", { text: heading }) : null,
    copy ? h("p", { text: copy }) : null,
  );
}
