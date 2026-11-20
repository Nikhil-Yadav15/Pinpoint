/**
 * ChatGPT Text Bookmarker — Page health check
 *
 * Purpose: when ChatGPT changes its page, the extension can stop working without any visible error.
 * This module checks, in one pass, every assumption the extension makes about the page, says in plain
 * words which one no longer holds, and remembers WHEN things were last healthy / first went wrong.
 *
 * Design rules:
 *  - Read-only. It never changes the page, your selection, or your bookmarks. (The full check's scroll
 *    test nudges the chat by a few pixels and puts it back; that only happens when you click it.)
 *  - It uses the REAL code paths (the same anchor builder / resolver as bookmarking and jumping), so a
 *    pass means "the actual feature works on this page", not "some selector matched".
 *  - It never throws into the rest of the extension, and its report contains no chat text.
 */
(function () {
  'use strict';

  const STATE_KEY = 'health';
  const STATUS = { healthy: 'healthy', attention: 'attention', broken: 'broken', unknown: 'unknown' };

  const HEADLINES = {
    healthy: 'Everything the extension relies on is working on this page.',
    attention: 'Working, but part of the page looks different from what the extension expects.',
    broken: 'Something the extension relies on has stopped working. ChatGPT may have changed its page.',
    unknown: 'Open a chat that contains responses to run the check.'
  };

  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

  /** How many elements each known page marker matches right now (the "what changed" evidence). */
  function countSignals(SELECTORS) {
    const out = [];
    for (const group of ['assistantUnitSelectors', 'userUnitSelectors', 'turnContainers', 'transcriptRoots', 'scrollHosts']) {
      for (const selector of SELECTORS[group] || []) {
        let count = 0;
        try {
          count = document.querySelectorAll(selector).length;
        } catch {
          count = -1; // the selector itself became invalid
        }
        out.push({ group, selector, count });
      }
    }
    return out;
  }

  /** A stretch of ordinary visible text inside an assistant response to run the round trip on. */
  function pickRoundTripTarget(messages) {
    const skip = 'pre, code, .katex, .katex-mathml, button, svg, [aria-hidden="true"], [data-cgpt-bm-ui="true"]';
    const viewportHeight = window.innerHeight;
    let fallback = null;
    let scanned = 0;

    for (const el of messages) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (++scanned > 600) return fallback;
        const text = node.nodeValue || '';
        if (norm(text).length < 40) continue;
        const parent = node.parentElement;
        if (!parent || parent.closest(skip)) continue;

        const choice = { el, node };
        const rect = parent.getBoundingClientRect();
        if (rect.bottom > 0 && rect.top < viewportHeight) return choice; // prefer what is on screen
        fallback = fallback || choice;
      }
    }
    return fallback;
  }

  function buildRange(node) {
    const text = node.nodeValue || '';
    let start = Math.max(0, Math.floor(text.length / 2) - 12);
    let end = Math.min(text.length, start + 24);
    if (text.slice(start, end).replace(/\s/g, '').length < 12) {
      start = Math.max(0, text.search(/\S/));
      end = Math.min(text.length, start + 24);
    }
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    return range;
  }

  function check(id, label, status, detail) {
    return { id, label, status, detail };
  }

  /**
   * deps: { selectors, engine, storage, probeScrollers }
   * options: { full } -- full adds the scroll test (nudges the page) and the storage test.
   */
  async function runChecks(deps, options = {}) {
    const { selectors, engine, storage, probeScrollers } = deps;
    const full = Boolean(options.full);
    const checks = [];
    const startedAt = Date.now();

    let signals = [];
    try {
      signals = countSignals(selectors.SELECTORS);
    } catch {
      // reported below through the other checks
    }

    const rendered = safe(() => selectors.getRenderedAssistantMessages(), []);
    const detected = safe(() => selectors.getAllAssistantMessages(), []);
    const turns = safe(() => selectors.getRenderedTurnElements(), []);
    const mountedIds = safe(() => selectors.getMountedMessageIds(), new Set());

    // 1. Are the assistant's responses recognised at all?
    if (rendered.length > 0) {
      checks.push(check('messages', 'Responses recognised', 'ok', `${rendered.length} response(s) recognised on screen.`));
    } else if (turns.length === 0 && detected.length === 0) {
      checks.push(check('messages', 'Responses recognised', 'skip', 'No messages on this page yet.'));
    } else {
      checks.push(
        check(
          'messages',
          'Responses recognised',
          'fail',
          'Messages are on the page but none is recognised as an assistant response. ChatGPT has probably changed how it marks them.'
        )
      );
    }
    const hasMessages = rendered.length > 0;

    // 2. Page markers (early warning: a marker the extension prefers disappeared)
    if (hasMessages) {
      const group = signals.filter((s) => s.group === 'assistantUnitSelectors');
      const primary = group[0];
      const anyMatch = group.some((s) => s.count > 0);
      if (primary && primary.count > 0) {
        checks.push(check('markers', 'Page markers', 'ok', 'The usual markers are present.'));
      } else if (anyMatch) {
        checks.push(
          check('markers', 'Page markers', 'warn', 'The preferred marker is gone; an alternative one is being used. Worth watching.')
        );
      } else {
        checks.push(
          check('markers', 'Page markers', 'warn', 'No known assistant marker matches; responses are being found by a fallback.')
        );
      }
    }

    // 3. Message ids
    if (hasMessages) {
      if (mountedIds.size > 0) {
        checks.push(check('ids', 'Message ids', 'ok', `${mountedIds.size} message id(s) found.`));
      } else {
        checks.push(
          check(
            'ids',
            'Message ids',
            'warn',
            'No message ids found. Bookmarks still work, but linking them to chats and re-finding messages is less reliable.'
          )
        );
      }
    }

    // 4. The real feature: create an anchor for some visible text, then locate it again.
    if (hasMessages) {
      try {
        const target = pickRoundTripTarget(rendered);
        if (!target) {
          checks.push(check('roundtrip', 'Bookmark round trip', 'skip', 'No plain text on screen to test with (only code or formulas).'));
        } else {
          const range = buildRange(target.node);
          const expected = norm(range.toString());
          const anchor = engine.createBookmarkAnchor(range, target.el);
          if (!anchor) {
            checks.push(check('roundtrip', 'Bookmark round trip', 'fail', 'A bookmark could not be created from visible text.'));
          } else {
            const res = engine.resolveBookmarkRange(anchor, target.el);
            const got = res && res.range ? norm(res.range.toString()) : '';
            if (res && res.status === 'resolved' && got === expected) {
              checks.push(check('roundtrip', 'Bookmark round trip', 'ok', 'A passage was bookmarked and found again at the exact same place.'));
            } else {
              checks.push(
                check(
                  'roundtrip',
                  'Bookmark round trip',
                  'fail',
                  `A bookmark was created but could not be found again (${(res && res.status) || 'no result'}). Finding passages is likely broken.`
                )
              );
            }
          }
        }
      } catch (err) {
        checks.push(check('roundtrip', 'Bookmark round trip', 'fail', `The bookmark engine raised an error: ${norm(err && err.message).slice(0, 120)}`));
      }
    }

    // 5. Chat identity
    const chatId = safe(() => selectors.getUrlChatId(), null);
    checks.push(
      chatId
        ? check('chat', 'Chat recognised', 'ok', 'This is a saved chat; bookmarks link to it.')
        : check('chat', 'Chat recognised', 'skip', 'New or temporary chat. Bookmarks attach to the chat once it is saved.')
    );

    // Full check only ----------------------------------------------------------------------------
    if (full) {
      if (hasMessages) {
        try {
          const ref = rendered[0];
          const probes = probeScrollers(ref);
          const moved = probes.find((p) => p.moved);
          const scrollable = probes.filter((p) => p.scrollable);
          if (moved) {
            checks.push(
              check('scroll', 'Scrolling', 'ok', `The conversation scroller was found (${Math.round(moved.el.scrollHeight)} px tall).`)
            );
          } else if (scrollable.length === 0) {
            checks.push(check('scroll', 'Scrolling', 'skip', 'This chat is short enough not to scroll; nothing to test.'));
          } else {
            checks.push(
              check(
                'scroll',
                'Scrolling',
                'fail',
                'A scrollable area exists but scrolling it does not move the messages. Jumping to far-away bookmarks will not work.'
              )
            );
          }
        } catch (err) {
          checks.push(check('scroll', 'Scrolling', 'fail', `The scroll test raised an error: ${norm(err && err.message).slice(0, 120)}`));
        }
      } else {
        checks.push(check('scroll', 'Scrolling', 'skip', 'Needs a chat with responses on screen.'));
      }

      try {
        await storage.probeStorage();
        checks.push(check('storage', 'Saving', 'ok', 'Bookmarks can be written and read back.'));
      } catch (err) {
        checks.push(check('storage', 'Saving', 'fail', `The browser refused to store data: ${norm(err && err.message).slice(0, 120)}`));
      }
    }

    // Overall status ----------------------------------------------------------------------------
    let status;
    if (checks.some((c) => c.status === 'fail')) status = STATUS.broken;
    else if (checks.some((c) => c.status === 'warn')) status = STATUS.attention;
    else if (checks.some((c) => c.status === 'ok' && c.id !== 'chat')) status = STATUS.healthy;
    else status = STATUS.unknown;

    return {
      status,
      headline: HEADLINES[status],
      full,
      at: Date.now(),
      tookMs: Date.now() - startedAt,
      checks,
      signals
    };
  }

  function safe(fn, fallback) {
    try {
      return fn();
    } catch {
      return fallback;
    }
  }

  /**
   * Remembers the outcome. Keeps "last healthy" and "problem first seen", so you can tell WHEN a
   * ChatGPT change broke something without having to remember. Writes only when something changed
   * (or at most every 10 minutes) so the check costs essentially nothing.
   */
  async function recordResult(storage, result, version) {
    let prev = {};
    try {
      prev = (await storage.getSetting(STATE_KEY, {})) || {};
    } catch {
      prev = {};
    }

    const now = result.at;
    const state = {
      status: result.status === STATUS.unknown && prev.status ? prev.status : result.status,
      lastRunAt: now,
      lastHealthyAt: prev.lastHealthyAt || null,
      firstProblemAt: prev.firstProblemAt || null,
      problems: prev.problems || [],
      version: version || prev.version || ''
    };

    if (result.status === STATUS.healthy) {
      state.lastHealthyAt = now;
      state.firstProblemAt = null;
      state.problems = [];
    } else if (result.status === STATUS.attention || result.status === STATUS.broken) {
      const wasProblem = prev.status === STATUS.attention || prev.status === STATUS.broken;
      state.firstProblemAt = wasProblem && prev.firstProblemAt ? prev.firstProblemAt : now;
      state.problems = result.checks.filter((c) => c.status === 'fail' || c.status === 'warn').map((c) => ({ id: c.id, status: c.status, detail: c.detail }));
    }

    const changed = state.status !== prev.status || state.firstProblemAt !== prev.firstProblemAt;
    if (changed || result.full || now - (prev.lastRunAt || 0) > 10 * 60 * 1000) {
      try {
        await storage.setSetting(STATE_KEY, state);
      } catch {
        // status is a convenience; never let it interfere
      }
    }
    return state;
  }

  async function loadState(storage) {
    try {
      return (await storage.getSetting(STATE_KEY, null)) || null;
    } catch {
      return null;
    }
  }

  window.CGPTBookmarkerHealth = { STATUS, HEADLINES, runChecks, recordResult, loadState };
})();
