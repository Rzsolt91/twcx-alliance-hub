/** Thin client for the portal API. Throws `ApiError` on any non-2xx reply. */

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(path, options = {}) {
  const response = await fetch(`/api/${path}`, options);

  if (response.status === 401) throw new ApiError("Your session has expired. Sign in again.", 401);

  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) {
    if (response.ok) return null;
    throw new ApiError(`Request failed (${response.status}).`, response.status);
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(payload?.error ?? `Request failed (${response.status}).`, response.status);
  }
  return payload;
}

export const api = {
  get: (path) => request(path),

  send: (method, path, body) =>
    request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    }),

  post: (path, body) => api.send("POST", path, body),
  patch: (path, body) => api.send("PATCH", path, body),
  del: (path) => request(path, { method: "DELETE" }),

  /** Multipart upload — the browser sets the boundary, so no content-type here. */
  upload: (path, formData) => request(path, { method: "POST", body: formData }),
};

/** Builds a query string, dropping empty values. */
export function qs(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}
