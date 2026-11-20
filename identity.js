/**
 * ChatGPT Text Bookmarker — Chat identity tracking
 *
 * Problem: ChatGPT is a single-page app. When you open another chat the URL changes first and the
 * old messages stay on screen for a moment; a brand-new chat even starts at "/" and only later
 * becomes "/c/<id>". Trusting the URL alone at the wrong instant files a bookmark under the wrong
 * chat (or under a shared "unsaved" bucket).
 *
 * Solution: never trust the URL alone. Message IDs are unique and never change (not even when a
 * chat is renamed), so a bookmark is linked to its chat by *observing its message in a chat page
 * whose URL and on-screen content agree*. The tracker below decides when that is the case.
 */
(function () {
  'use strict';

  // One id per page load. Bookmarks made on a not-yet-saved chat carry it, so they can be shown
  // in "This Chat" until the chat gets its real id.
  const SESSION_ID =
    's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);

  const URL_STABLE_MS = 1200; // URL unchanged for this long
  const DOM_STABLE_MS = 600; // set of mounted message ids unchanged for this long
  const WEAK_SETTLE_MS = 6000; // fallback: stable this long even without positive evidence
  const TITLE_STABLE_MS = 1500;
  const GENERIC_TITLE = 'ChatGPT Conversation';

  /** A stored message id can be several ids joined by spaces; split it into single ids. */
  function messageIdTokens(messageId) {
    return String(messageId || '')
      .split(/[\s,]+/)
      .filter(Boolean);
  }

  function sameSet(a, b) {
    if (a.size !== b.size) return false;
    for (const x of a) if (!b.has(x)) return false;
    return true;
  }

  function intersects(a, b) {
    for (const x of a) if (b.has(x)) return true;
    return false;
  }

  /**
   * deps: { getUrlChatId(): string|null, getMountedIds(): Set<string>, getTitle?(): string,
   *         now?(): number }
   *
   * poll() returns a snapshot:
   *   urlId        chat id from the URL (null = not a saved chat)
   *   strong       URL and on-screen messages positively agree -> safe to LINK bookmarks to urlId
   *   weak         stable for a long time without contradiction -> safe enough to STAMP a new one
   *   ids          mounted message ids
   *   idsVersion   increments whenever the mounted set changes (virtualized lists mount more as you scroll)
   *   title / titleFresh  document title, and whether it is stable and belongs to this chat
   */
  function createIdentityTracker(deps) {
    const now = deps.now || (() => Date.now());
    const t0 = now();

    const s = {
      urlId: undefined,
      prevUrlId: undefined,
      hasPrev: false,
      prevIds: new Set(),
      lastIds: new Set(),
      urlChangedAt: t0,
      idsChangedAt: t0,
      idsVersion: 0,
      strong: false,
      weak: false,
      title: '',
      titleChangedAt: t0
    };

    function poll() {
      const t = now();
      const urlId = deps.getUrlChatId();
      const ids = deps.getMountedIds();
      const title = deps.getTitle ? deps.getTitle() : '';

      if (urlId !== s.urlId) {
        if (s.urlId !== undefined) {
          s.prevUrlId = s.urlId;
          s.prevIds = s.lastIds; // what was on screen BEFORE the URL changed
          s.hasPrev = true;
        }
        s.urlId = urlId;
        s.urlChangedAt = t;
        s.strong = false;
        s.weak = false;
      }

      if (!sameSet(ids, s.lastIds)) {
        s.idsChangedAt = t;
        s.idsVersion++;
      }
      s.lastIds = ids;

      if (title !== s.title) {
        s.title = title;
        s.titleChangedAt = t;
      }

      if (!s.strong) {
        const urlStable = t - s.urlChangedAt >= URL_STABLE_MS;
        const domStable = t - s.idsChangedAt >= DOM_STABLE_MS;

        if (urlStable && domStable) {
          if (s.urlId === null) {
            s.strong = true; // nothing to verify on a page without a chat id
          } else if (ids.size > 0) {
            if (!s.hasPrev) {
              s.strong = true; // fresh page load
            } else if (s.prevIds.size === 0) {
              s.strong = true; // nothing from a previous chat could still be on screen
            } else if (!intersects(ids, s.prevIds)) {
              s.strong = true; // the old chat's messages are gone -> the new chat is on screen
            } else if (s.prevUrlId === null) {
              s.strong = true; // "/" -> "/c/<id>": same messages, the new chat just got its id
            }
          }
          if (!s.strong && t - s.urlChangedAt >= WEAK_SETTLE_MS && (ids.size > 0 || s.urlId === null)) {
            s.weak = true;
          }
        }
      }

      const titleFresh =
        t - s.titleChangedAt >= TITLE_STABLE_MS &&
        (s.titleChangedAt > s.urlChangedAt || t - s.urlChangedAt >= WEAK_SETTLE_MS);

      return {
        urlId: s.urlId,
        strong: s.strong,
        weak: s.weak,
        ids,
        idsVersion: s.idsVersion,
        title,
        titleFresh
      };
    }

    return { poll };
  }

  /**
   * Pure function: given all bookmarks and a snapshot taken while `snap.strong` is true, returns
   * { [bookmarkId]: patch } describing what to correct.
   *  - a bookmark whose message is on screen is linked to this chat (membership is added, never
   *    removed, so a message shared by two chats, e.g. a branch, shows up in both)
   *  - a bookmark with no chat yet adopts this chat
   *  - the stored chat title is refreshed (cosmetic only: identity never depends on the title)
   */
  function computeIdentityPatches(bookmarks, snap, pathname) {
    const patches = {};
    if (!snap || !snap.strong || !snap.urlId) return patches;

    for (const bm of bookmarks) {
      const patch = {};
      const onScreen = messageIdTokens(bm.messageId).some((token) => snap.ids.has(token));

      if (onScreen) {
        if (!bm.conversationIds.includes(snap.urlId)) {
          patch.conversationIds = [...bm.conversationIds, snap.urlId];
        }
        if (bm.conversationId === null) {
          patch.conversationId = snap.urlId;
          patch.conversationPath = pathname;
        }
      }

      const belongsHere = bm.conversationId === snap.urlId || onScreen;
      if (
        belongsHere &&
        snap.titleFresh &&
        snap.title &&
        snap.title !== GENERIC_TITLE &&
        bm.conversationTitle !== snap.title &&
        (bm.conversationId === snap.urlId || patch.conversationId === snap.urlId)
      ) {
        patch.conversationTitle = snap.title;
      }

      if (Object.keys(patch).length > 0) patches[bm.id] = patch;
    }
    return patches;
  }

  window.CGPTBookmarkerIdentity = {
    SESSION_ID,
    GENERIC_TITLE,
    createIdentityTracker,
    computeIdentityPatches,
    messageIdTokens
  };
})();
