/**
 * Alliance lounge: the weekly meme contest, suggestions and complaints, and
 * the quizzes/contests that feed the leaderboard.
 */

import { api } from "../lib/api.js";
import { hero, postUrl, siteContent } from "../lib/content.js";
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
  stat,
  toast,
} from "../lib/dom.js";
import { formatServerDate } from "../lib/clock.js";
import { t } from "../lib/i18n.js";
import { canManage, serverToday } from "../lib/store.js";

const FEEDBACK_KINDS = ["SUGGESTION", "COMPLAINT"];
const ACTIVITY_KINDS = ["QUIZ", "CONTEST", "GAME"];
const NUMBER = new Intl.NumberFormat("en-GB");

export default async function communityView() {
  const manage = canManage();
  let week = "";

  const content = await siteContent();
  const root = h("div", { class: "stack" });

  /* ---------------------------------------------------------------- memes --- */

  function postDialog() {
    const titleInput = input({ type: "text", maxlength: 120, required: true });
    const noteInput = h("textarea", { maxlength: 600 });
    const fileInput = input({
      type: "file",
      required: true,
      accept: "image/png,image/jpeg,image/webp,image/gif,image/avif",
    });

    modal({
      title: t("community.postMeme"),
      body: h(
        "div",
        { class: "form" },
        field(t("community.memeTitle"), titleInput),
        field(`${t("community.message")} (${t("common.optional")})`, noteInput),
        field(t("community.memeImage"), fileInput, t("admin.maxSize")),
      ),
      actions: (close) => [
        h("button", { class: "btn btn--ghost", type: "button", onClick: close }, t("common.cancel")),
        h(
          "button",
          {
            class: "btn btn--primary",
            type: "button",
            onClick: async (clickEvent) => {
              const file = fileInput.files?.[0];
              if (!file || !titleInput.value.trim()) {
                toast(t("community.memeImage"), "error");
                return;
              }
              clickEvent.currentTarget.disabled = true;
              const form = new FormData();
              form.set("title", titleInput.value.trim());
              form.set("description", noteInput.value.trim());
              form.set("image", file);
              try {
                await api.upload("community/posts", form);
                close();
                toast(t("common.saved"), "ok");
                await load();
              } catch (error) {
                toast(error.message, "error");
                clickEvent.currentTarget.disabled = false;
              }
            },
          },
          t("common.upload"),
        ),
      ],
    });
  }

  async function like(post, button, counter) {
    button.disabled = true;
    try {
      const result = await api.post("community/likes", { postId: post.id });
      post.liked = result.liked;
      post.likes = result.likes;
      button.setAttribute("aria-pressed", result.liked ? "true" : "false");
      counter.textContent = String(result.likes);
    } catch (error) {
      toast(error.message, "error");
    } finally {
      button.disabled = false;
    }
  }

  async function removePost(post) {
    const confirmed = await confirmDialog({
      title: t("community.deleteMeme"),
      message: t("community.deleteMemeBody", { title: post.title }),
      confirmLabel: t("common.delete"),
    });
    if (!confirmed) return;
    try {
      await api.del(`community/posts?id=${post.id}`);
      toast(t("common.deleted"), "ok");
      await load();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  function awardDialog(post) {
    const prizeInput = input({ type: "text", maxlength: 160, value: "" });
    modal({
      title: t("community.awardPrize"),
      body: h("div", { class: "form" }, h("p", { text: post.title }), field(t("community.prize"), prizeInput)),
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
                await api.post("community/winner", { postId: post.id, prize: prizeInput.value.trim() });
                close();
                toast(t("community.prizeAwarded", { name: post.author }), "ok");
                await load();
              } catch (error) {
                toast(error.message, "error");
                clickEvent.currentTarget.disabled = false;
              }
            },
          },
          t("community.awardPrize"),
        ),
      ],
    });
  }

  function memeCard(post, winnerId) {
    const counter = h("span", { text: String(post.likes) });
    const likeButton = h(
      "button",
      {
        class: "like",
        type: "button",
        "aria-pressed": post.liked ? "true" : "false",
        "aria-label": t("community.likes", { count: post.likes }),
        onClick: () => like(post, likeButton, counter),
      },
      icon("heart"),
      counter,
    );

    return h(
      "article",
      { class: ["meme", post.id === winnerId && "meme--winner"] },
      post.id === winnerId ? h("div", { class: "meme__crown" }, chip(t("community.winner"), "signal")) : null,
      post.imageId
        ? h("img", {
            src: postUrl(post.imageId),
            alt: post.title,
            loading: "lazy",
            style: { cursor: "zoom-in" },
            onClick: () => lightbox(postUrl(post.imageId), post.title),
          })
        : null,
      h(
        "div",
        { class: "meme__body" },
        h("div", { class: "meme__title", text: post.title }),
        h("div", { class: "meme__author", text: t("common.by", { name: post.author }) }),
        post.description ? h("p", { class: "muted", text: post.description }) : null,
      ),
      h(
        "div",
        { class: "meme__foot" },
        likeButton,
        h("div", { class: "spacer", style: { flex: "1" } }),
        manage
          ? h(
              "button",
              { class: "iconbtn", type: "button", "aria-label": t("community.awardPrize"), onClick: () => awardDialog(post) },
              icon("award"),
            )
          : null,
        post.mine || manage
          ? h(
              "button",
              { class: "iconbtn", type: "button", "aria-label": t("common.delete"), onClick: () => removePost(post) },
              icon("trash"),
            )
          : null,
      ),
    );
  }

  /* ------------------------------------------------------------- feedback --- */

  function feedbackDialog() {
    const kindSelect = select(
      { value: "SUGGESTION" },
      FEEDBACK_KINDS.map((kind) => ({ value: kind, label: t(`community.kind.${kind}`) })),
    );
    const subjectInput = input({ type: "text", maxlength: 140, required: true });
    const messageInput = h("textarea", { maxlength: 3000, rows: 6, required: true });

    modal({
      title: t("community.newFeedback"),
      body: h(
        "div",
        { class: "form" },
        field(t("community.kind"), kindSelect),
        field(t("community.subject"), subjectInput),
        field(t("community.message"), messageInput),
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
                await api.post("community/feedback", {
                  kind: kindSelect.value,
                  subject: subjectInput.value.trim(),
                  message: messageInput.value.trim(),
                });
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

  async function setFeedbackStatus(report, status) {
    try {
      await api.patch("community/feedback", { id: report.id, status });
      await load();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  function feedbackList(reports) {
    if (!reports.length) return empty(t("community.feedbackEmpty"));

    return h(
      "div",
      { class: "stack" },
      ...reports.map((report) =>
        h(
          "div",
          { class: "entry" },
          h(
            "div",
            { class: "entry__when" },
            h("div", { class: "entry__day", text: t(`community.kind.${report.kind}`) }),
            h("div", { class: "entry__date", text: String(report.createdAt).slice(0, 10) }),
          ),
          h(
            "div",
            { class: "entry__main" },
            h("div", { class: "entry__title", text: report.subject }),
            h("p", { class: "muted", text: report.message }),
            h(
              "div",
              { class: "entry__meta" },
              chip(t(`community.status.${report.status}`), report.status === "OPEN" ? "alert" : "go"),
              h("span", { text: t("common.by", { name: report.author }) }),
            ),
          ),
          manage
            ? h(
                "div",
                { class: "entry__aside" },
                h(
                  "button",
                  {
                    class: "btn btn--ghost btn--small",
                    type: "button",
                    onClick: () => setFeedbackStatus(report, report.status === "OPEN" ? "RESOLVED" : "OPEN"),
                  },
                  icon(report.status === "OPEN" ? "check" : "refresh"),
                  report.status === "OPEN" ? t("community.resolve") : t("community.reopen"),
                ),
              )
            : null,
        ),
      ),
    );
  }

  /* ----------------------------------------------------------- activities --- */

  function activityDialog(activity) {
    const titleInput = input({ type: "text", maxlength: 120, value: activity?.title ?? "", required: true });
    const kindSelect = select(
      { value: activity?.kind ?? "QUIZ" },
      ACTIVITY_KINDS.map((kind) => ({ value: kind, label: t(`community.activityKind.${kind}`) })),
    );
    const closesInput = input({ type: "date", value: activity?.closesOn ?? "" });
    const descInput = h("textarea", { maxlength: 2000, rows: 5 }, activity?.description ?? "");

    modal({
      title: activity ? t("common.edit") : t("community.newActivity"),
      body: h(
        "div",
        { class: "form" },
        field(t("calendar.eventTitle"), titleInput),
        h("div", { class: "form form--inline" }, field(t("community.kind"), kindSelect), field(t("community.closesOn"), closesInput)),
        field(t("community.message"), descInput),
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
                await api.post("community/games", {
                  id: activity?.id,
                  title: titleInput.value.trim(),
                  kind: kindSelect.value,
                  closesOn: closesInput.value || null,
                  description: descInput.value.trim(),
                });
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

  async function removeActivity(activity) {
    const confirmed = await confirmDialog({
      title: t("common.delete"),
      message: activity.title,
      confirmLabel: t("common.delete"),
    });
    if (!confirmed) return;
    try {
      await api.del(`community/games?id=${activity.id}`);
      toast(t("common.deleted"), "ok");
      await load();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  function scoreDialog(activity) {
    const scoreInput = input({ type: "number", min: "0", step: "1", value: String(activity.myScore ?? 0) });
    modal({
      title: `${t("community.submitScore")} · ${activity.title}`,
      body: h(
        "div",
        { class: "form" },
        activity.description ? h("p", { class: "muted", text: activity.description }) : null,
        field(t("community.score"), scoreInput),
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
                await api.post("community/scores", { gameId: activity.id, score: Number(scoreInput.value || 0) });
                close();
                toast(t("common.saved"), "ok");
                await load();
              } catch (error) {
                toast(error.message, "error");
                clickEvent.currentTarget.disabled = false;
              }
            },
          },
          t("community.submitScore"),
        ),
      ],
    });
  }

  function activityList(activities) {
    if (!activities.length) return empty(t("community.activitiesEmpty"), manage ? t("community.newActivity") : undefined);
    const today = serverToday();

    return h(
      "div",
      { class: "stack" },
      ...activities.map((activity) => {
        const closed = Boolean(activity.closesOn && activity.closesOn < today);
        return h(
          "div",
          { class: "entry" },
          h(
            "div",
            { class: "entry__when" },
            h("div", { class: "entry__day", text: t(`community.activityKind.${activity.kind}`) }),
            h("div", {
              class: "entry__date",
              text: activity.closesOn ? formatServerDate(activity.closesOn, { weekday: false }) : "—",
            }),
          ),
          h(
            "div",
            { class: "entry__main" },
            h("div", { class: "entry__title", text: activity.title }),
            activity.description ? h("p", { class: "muted", text: activity.description }) : null,
            h(
              "div",
              { class: "entry__meta" },
              h("span", { text: t("community.entries", { count: activity.entries }) }),
              activity.myScore === null
                ? null
                : h("span", { text: t("community.myScore", { score: NUMBER.format(activity.myScore) }) }),
              closed ? chip(t("community.status.RESOLVED"), "relay") : null,
            ),
          ),
          h(
            "div",
            { class: "entry__aside" },
            closed
              ? null
              : h(
                  "button",
                  { class: "btn btn--primary btn--small", type: "button", onClick: () => scoreDialog(activity) },
                  icon("target"),
                  t("community.submitScore"),
                ),
            manage
              ? h(
                  "button",
                  { class: "iconbtn", type: "button", "aria-label": t("common.edit"), onClick: () => activityDialog(activity) },
                  icon("edit"),
                )
              : null,
            manage
              ? h(
                  "button",
                  { class: "iconbtn", type: "button", "aria-label": t("common.delete"), onClick: () => removeActivity(activity) },
                  icon("trash"),
                )
              : null,
          ),
        );
      }),
    );
  }

  function leaderboardPanel(rows) {
    return panel({
      title: t("community.leaderboard"),
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
                  h("th", { class: "rank", text: "#" }),
                  h("th", { text: t("squads.name") }),
                  h("th", { class: "num", text: t("community.score") }),
                  h("th", { class: "num", text: t("community.activities") }),
                ),
              ),
              h(
                "tbody",
                {},
                ...rows.map((row, index) =>
                  h(
                    "tr",
                    {},
                    h("td", { class: "rank", text: String(index + 1) }),
                    h("td", { class: "name", text: row.name }),
                    h("td", { class: "num", text: NUMBER.format(row.score) }),
                    h("td", { class: "num", text: t("community.played", { count: row.played }) }),
                  ),
                ),
              ),
            ),
          )
        : empty(t("community.leaderboardEmpty")),
      flush: rows.length > 0,
    });
  }

  /* ----------------------------------------------------------------- draw --- */

  async function load() {
    const data = await api.get(week ? `community?week=${week}` : "community");
    week = data.weekStart;
    const winnerId = data.winner?.postId ?? null;
    const openReports = data.feedback.filter((report) => report.status === "OPEN").length;

    fill(
      root,
      hero(content?.sections ?? {}, "community", { title: t("community.title"), body: t("community.subtitle") }),
      h(
        "div",
        { class: "grid--stats" },
        stat({ label: t("community.memes"), value: String(data.posts.length) }),
        stat({
          label: t("community.winner"),
          value: data.winner ? data.winner.author : "—",
          note: data.winner?.prize || undefined,
          tone: data.winner ? "signal" : undefined,
        }),
        stat({ label: t("community.feedback"), value: String(openReports), tone: openReports ? "alert" : undefined }),
        stat({ label: t("community.activities"), value: String(data.activities.length) }),
      ),
      panel({
        title: t("community.memes"),
        subtitle: `${t("community.memesNote")} · ${t("common.week", {
          date: formatServerDate(data.weekStart, { year: true }),
        })}`,
        actions: frag(
          h(
            "button",
            {
              class: "iconbtn",
              type: "button",
              "aria-label": t("common.previous"),
              onClick: () => {
                week = data.previousWeek;
                load();
              },
            },
            icon("left"),
          ),
          h(
            "button",
            {
              class: "btn btn--ghost btn--small",
              type: "button",
              onClick: () => {
                week = data.currentWeek;
                load();
              },
            },
            t("common.thisWeek"),
          ),
          h(
            "button",
            {
              class: "iconbtn",
              type: "button",
              "aria-label": t("common.next"),
              onClick: () => {
                week = data.nextWeek;
                load();
              },
            },
            icon("right"),
          ),
          h(
            "button",
            { class: "btn btn--primary btn--small", type: "button", onClick: postDialog },
            icon("upload"),
            t("community.postMeme"),
          ),
        ),
        body: data.posts.length
          ? h("div", { class: "board" }, ...data.posts.map((post) => memeCard(post, winnerId)))
          : empty(t("community.memesEmpty"), t("community.memesNote")),
      }),
      h(
        "div",
        { class: "grid--lead" },
        panel({
          title: t("community.activities"),
          subtitle: t("community.activitiesNote"),
          actions: manage
            ? h(
                "button",
                { class: "btn btn--ghost btn--small", type: "button", onClick: () => activityDialog(null) },
                icon("plus"),
                t("community.newActivity"),
              )
            : undefined,
          body: activityList(data.activities),
        }),
        leaderboardPanel(data.leaderboard),
      ),
      panel({
        title: t("community.feedback"),
        subtitle: t("community.feedbackNote"),
        actions: h(
          "button",
          { class: "btn btn--primary btn--small", type: "button", onClick: feedbackDialog },
          icon("plus"),
          t("community.newFeedback"),
        ),
        body: feedbackList(data.feedback),
      }),
    );
  }

  await load();
  return root;
}
