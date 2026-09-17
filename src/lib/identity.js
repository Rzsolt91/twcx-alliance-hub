/** Friendly wording for the errors thrown by the Identity client. */

import { AuthError, MissingIdentityError } from "@netlify/identity";
import { ApiError } from "./api.js";
import { t } from "./i18n.js";

export function authMessage(error) {
  if (error instanceof MissingIdentityError) {
    return "Identity is not enabled on this site yet, so sign-in is unavailable.";
  }
  if (error instanceof AuthError) {
    switch (error.status) {
      case 401:
        return "Wrong email or password.";
      case 403:
        return "Registration is closed. Ask a Master for an invite.";
      case 404:
        return "No account uses that email.";
      case 422:
        return "Check the email address and use a password of at least 8 characters.";
      default:
        return error.message;
    }
  }
  if (error instanceof ApiError) return error.message;
  // Validation errors raised by the forms themselves already read well.
  if (typeof error?.message === "string" && error.message) return error.message;
  return t("common.error");
}
