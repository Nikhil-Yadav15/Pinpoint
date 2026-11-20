/**
 * ChatGPT Text Bookmarker — Centralized DOM Selector Registry & Adapter (v1.1)
 *
 * Built specifically for ChatGPT's live DOM architecture:
 * - Assistant & user roles via [data-conversation-role="assistant"|"user"]
 * - Search unit keys via [data-chatgpt-search-unit-key$=":assistant"] & [data-content-search-unit-key$=":assistant"]
 * - Message UUIDs via [data-chatgpt-search-message-ids] and turn wrappers via [data-turn-key]
 * - Text blocks rendered with [data-d-component], [data-d-text-flow], [data-d-block], [data-d-inline]
 * - Scroll container via [data-mcp-app-scroll-host="true"] / [data-app-action-timeline-scroll]
 * - Also preserves legacy fallbacks ([data-message-author-role="assistant"], article[data-testid^="conversation-turn-"])
 */
(function () {
  'use strict';

  const SELECTORS = {
    // Primary selectors for assistant message roots in current & legacy ChatGPT builds
    assistantUnitSelectors: [
      '[data-conversation-role="assistant"]',
      '[data-chatgpt-search-unit-key$=":assistant"]',
      '[data-content-search-unit-key$=":assistant"]',
      '[data-message-author-role="assistant"]'
    ],

    // Selectors that identify a user message (must never be bookmarked)
    userUnitSelectors: [
      '[data-conversation-role="user"]',
      '[data-chatgpt-search-unit-key$=":user"]',
      '[data-content-search-unit-key$=":user"]',
      '[data-message-author-role="user"]'
    ],

    // Turn wrapper selectors
    turnContainers: [
      '[data-turn-key]',
      'article[data-testid^="conversation-turn-"]',
      '[data-testid^="conversation-turn-"]'
    ],

    // Transcript root containers
    transcriptRoots: [
      '[data-chatgpt-conversation-selection-target]',
      '[data-rail-chat-transcript]',
      '[data-thread-find-target]',
      '[data-thread-user-message-navigation-content]',
      'main'
    ],

    // Scrollable conversation viewport containers
    scrollHosts: [
      '[data-mcp-app-scroll-host="true"]',
      '[data-mcp-app-scroll-host]',
      '[data-app-action-timeline-scroll]'
    ],

    // Subtrees to skip when building the normalized text map of an assistant response
    excludedSubtrees: [
      '[data-cgpt-bm-ui="true"]',
      'script',
      'style',
      'noscript',
      'svg',
      '.katex-mathml',
      'button[aria-label*="Copy"]',
      '[data-conversation-role="user"]',
      '[data-chatgpt-search-unit-key$=":user"]',
      '[data-content-search-unit-key$=":user"]',
      '[data-message-author-role="user"]'
    ]
  };

  const ASSISTANT_UNIT_QUERY = SELECTORS.assistantUnitSelectors.join(', ');
  const USER_UNIT_QUERY = SELECTORS.userUnitSelectors.join(', ');
  const TURN_CONTAINER_QUERY = SELECTORS.turnContainers.join(', ');
  const TRANSCRIPT_ROOT_QUERY = SELECTORS.transcriptRoots.join(', ');
  const SCROLL_HOST_QUERY = SELECTORS.scrollHosts.join(', ');

  /**
   * Extracts the current ChatGPT conversation ID from the URL pathname.
   * Supports /c/<uuid> and /g/<gpt-id>/c/<uuid>.
   */
  function getConversationId() {
    const path = window.location.pathname || '';
    const match = path.match(/\/c\/([a-zA-Z0-9_-]+)/);
    if (match && match[1]) {
      return match[1];
    }
    const gMatch = path.match(/\/g\/([a-zA-Z0-9_-]+)\/c\/([a-zA-Z0-9_-]+)/);
    if (gMatch && gMatch[2]) {
      return gMatch[2];
    }
    return 'unsaved-root-chat';
  }

  /**
   * The chat ID from the URL, or null when the page is not a saved chat (new chat, temporary
   * chat, GPT/project home...). Unlike getConversationId() there is NO shared placeholder value:
   * a bookmark made on such a page must not be filed under a bucket that every other unsaved page
   * also shares.
   */
  function getUrlChatId() {
    const path = window.location.pathname || '';
    const match = path.match(/\/c\/([a-zA-Z0-9_-]+)/);
    return match && match[1] ? match[1] : null;
  }

  /**
   * IDs of all messages currently mounted in the DOM. Message IDs are unique per message and never
   * change when a chat is renamed, which makes them the reliable link between a bookmark and the
   * chat it really lives in.
   */
  function getMountedMessageIds() {
    const ids = new Set();
    const nodes = document.querySelectorAll('[data-message-id], [data-chatgpt-search-message-ids]');
    for (const node of nodes) {
      const single = node.getAttribute('data-message-id');
      if (single) ids.add(single.trim());
      const multi = node.getAttribute('data-chatgpt-search-message-ids');
      if (multi) {
        for (const part of multi.split(/[\s,]+/)) {
          if (part) ids.add(part);
        }
      }
    }
    return ids;
  }

  /**
   * Returns a clean title for the active conversation.
   */
  function getConversationTitle() {
    const rawTitle = (document.title || '').replace(/\s*[-|·]\s*ChatGPT.*$/i, '').trim();
    return rawTitle && rawTitle.toLowerCase() !== 'chatgpt' ? rawTitle : 'ChatGPT Conversation';
  }

  /**
   * Given a matched assistant marker element (e.g. [data-conversation-role="assistant"]),
   * resolves the actual DOM element that contains the assistant's rendered response text.
   * Handles cases where data-conversation-role="assistant" is on a wrapper OR on a header/sibling
   * inside [data-turn-key].
   */
  function resolveContentRootFromAssistantNode(assistantNode) {
    if (!assistantNode) return null;

    const textLen = (assistantNode.textContent || '').trim().length;
    if (textLen > 0) {
      return assistantNode;
    }

    // If the attribute was placed on an empty marker/header element inside a turn,
    // promote to the enclosing [data-turn-key] or parent container that holds the text.
    const turnAncestor = assistantNode.closest(TURN_CONTAINER_QUERY);
    if (turnAncestor && (turnAncestor.textContent || '').trim().length > 0) {
      return turnAncestor;
    }

    let parent = assistantNode.parentElement;
    while (parent && parent !== document.body) {
      if ((parent.textContent || '').trim().length > 0) {
        return parent;
      }
      parent = parent.parentElement;
    }

    return assistantNode;
  }

  /**
   * Returns a deduplicated, DOM-ordered list of all assistant message container elements.
   */
  function getAllAssistantMessages() {
    const seen = new Set();
    const results = [];

    function addCandidate(el) {
      if (!el || seen.has(el)) return;
      // Avoid adding both an outer turn container and an inner assistant container for the same message
      for (const existing of seen) {
        if (existing.contains(el) || el.contains(existing)) {
          return;
        }
      }
      seen.add(el);
      results.push(el);
    }

    // 1. Primary lookup: [data-conversation-role="assistant"], [data-chatgpt-search-unit-key$=":assistant"], etc.
    const directMatches = Array.from(document.querySelectorAll(ASSISTANT_UNIT_QUERY));
    for (const node of directMatches) {
      const resolved = resolveContentRootFromAssistantNode(node);
      if (resolved) {
        addCandidate(resolved);
      }
    }

    if (results.length > 0) {
      return results;
    }

    // 2. Turn-key lookup: [data-turn-key] elements that do not represent user turns
    const turns = Array.from(document.querySelectorAll(TURN_CONTAINER_QUERY));
    for (const turn of turns) {
      const isUserOnly =
        turn.matches(USER_UNIT_QUERY) ||
        (Boolean(turn.querySelector(USER_UNIT_QUERY)) && !turn.querySelector(ASSISTANT_UNIT_QUERY));
      if (!isUserOnly && (turn.textContent || '').trim().length > 0) {
        addCandidate(turn);
      }
    }

    return results;
  }

  /**
   * Given any DOM node (e.g. Selection startContainer or endContainer), finds the enclosing
   * ChatGPT assistant response container, or null if the selection is outside an assistant message.
   */
  function findEnclosingAssistantMessage(node) {
    if (!node) return null;
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!element) return null;

    // 1. Never match inside our own extension UI or inside editable inputs/textareas
    if (
      element.closest('[data-cgpt-bm-ui="true"]') ||
      element.closest('textarea, input, [contenteditable="true"], form')
    ) {
      return null;
    }

    // 2. Reject if directly inside a user message container
    const userAncestor = element.closest(USER_UNIT_QUERY);
    const assistantAncestor = element.closest(ASSISTANT_UNIT_QUERY);
    if (userAncestor && (!assistantAncestor || userAncestor.contains(assistantAncestor))) {
      return null;
    }

    // 3. Direct ancestor match on [data-conversation-role="assistant"],
    //    [data-chatgpt-search-unit-key$=":assistant"], [data-content-search-unit-key$=":assistant"], etc.
    if (assistantAncestor) {
      return resolveContentRootFromAssistantNode(assistantAncestor);
    }

    // 4. Check enclosing [data-turn-key] (handles cases where data-conversation-role="assistant"
    //    is placed on a sibling node or child metadata element inside the same [data-turn-key])
    const turnEl = element.closest(TURN_CONTAINER_QUERY);
    if (turnEl) {
      const assistantMarkerInTurn = turnEl.matches(ASSISTANT_UNIT_QUERY)
        ? turnEl
        : turnEl.querySelector(ASSISTANT_UNIT_QUERY);

      if (assistantMarkerInTurn) {
        // Make sure the selected element is not inside a user sub-branch of this turn
        if (!element.closest(USER_UNIT_QUERY)) {
          const resolved = resolveContentRootFromAssistantNode(assistantMarkerInTurn);
          return resolved && resolved.contains(element) ? resolved : turnEl;
        }
      }

      // If the turn has no user marker at all, treat the turn inside the transcript as an assistant turn
      if (!turnEl.matches(USER_UNIT_QUERY) && !turnEl.querySelector(USER_UNIT_QUERY)) {
        return turnEl;
      }
    }

    // 5. Fallback for [data-d-text-flow] / [data-d-component] inside the conversation transcript
    const inTranscript = element.closest(TRANSCRIPT_ROOT_QUERY);
    const inDTextFlow = element.closest('[data-d-text-flow], [data-d-component], .markdown, .prose');
    if (inTranscript && inDTextFlow && !element.closest(USER_UNIT_QUERY)) {
      // Walk up from the text flow to find any ancestor that contains an assistant marker
      let curr = element;
      while (curr && curr !== inTranscript && curr !== document.body) {
        if (curr.matches && curr.matches(ASSISTANT_UNIT_QUERY)) {
          return curr;
        }
        if (curr.querySelector && curr.querySelector(ASSISTANT_UNIT_QUERY)) {
          if (!curr.querySelector(USER_UNIT_QUERY)) {
            return curr;
          }
        }
        curr = curr.parentElement;
      }
      // Otherwise use the highest non-user block inside the transcript root
      let block = inDTextFlow;
      while (
        block.parentElement &&
        block.parentElement !== inTranscript &&
        !block.parentElement.querySelector(USER_UNIT_QUERY)
      ) {
        block = block.parentElement;
      }
      return block;
    }

    return null;
  }

  /**
   * Helper to read an attribute from containerEl, its closest ancestor (up to [data-turn-key]),
   * or its first matching descendant.
   */
  function extractAttributeAroundContainer(containerEl, attrName, selectorFilter) {
    if (!containerEl) return null;

    if (containerEl.hasAttribute && containerEl.hasAttribute(attrName)) {
      const val = containerEl.getAttribute(attrName);
      if (val) return val;
    }

    const turnScope = containerEl.closest(TURN_CONTAINER_QUERY) || containerEl;
    if (turnScope.hasAttribute && turnScope.hasAttribute(attrName)) {
      const val = turnScope.getAttribute(attrName);
      if (val) return val;
    }

    const query = selectorFilter ? `${selectorFilter}[${attrName}]` : `[${attrName}]`;
    const descendant =
      containerEl.querySelector(query) ||
      (turnScope !== containerEl ? turnScope.querySelector(query) : null);
    if (descendant) {
      const val = descendant.getAttribute(attrName);
      if (val) return val;
    }

    const ancestor = containerEl.closest(`[${attrName}]`);
    if (ancestor) {
      const val = ancestor.getAttribute(attrName);
      if (val) return val;
    }

    return null;
  }

  /**
   * Extracts stable identifying metadata for a given assistant response container.
   * Supports data-chatgpt-search-message-ids, data-turn-key, data-chatgpt-search-unit-key,
   * data-content-search-unit-key, data-message-id, and turnIndex.
   */
  function getAssistantMessageMeta(containerEl) {
    if (!containerEl) {
      return {
        messageId: null,
        turnKey: null,
        searchUnitKey: null,
        turnTestId: null,
        turnIndex: -1
      };
    }

    // 1. Message UUID (data-chatgpt-search-message-ids or legacy data-message-id)
    const searchMessageIds = extractAttributeAroundContainer(
      containerEl,
      'data-chatgpt-search-message-ids'
    );
    const legacyMessageId = extractAttributeAroundContainer(containerEl, 'data-message-id');
    const messageId = searchMessageIds || legacyMessageId || null;

    // 2. Turn key (data-turn-key)
    const turnKey = extractAttributeAroundContainer(containerEl, 'data-turn-key');

    // 3. Search unit key (data-chatgpt-search-unit-key / data-content-search-unit-key)
    const searchUnitKey =
      extractAttributeAroundContainer(containerEl, 'data-chatgpt-search-unit-key') ||
      extractAttributeAroundContainer(containerEl, 'data-content-search-unit-key');

    // 4. Legacy data-testid
    const turnTestId = extractAttributeAroundContainer(containerEl, 'data-testid');

    // 5. Assistant turn index in conversation
    const allAssistant = getAllAssistantMessages();
    let turnIndex = allAssistant.indexOf(containerEl);
    if (turnIndex === -1) {
      turnIndex = allAssistant.findIndex(
        (el) => el.contains(containerEl) || containerEl.contains(el)
      );
    }

    return {
      messageId,
      turnKey: turnKey || null,
      searchUnitKey: searchUnitKey || null,
      turnTestId: turnTestId || null,
      turnIndex
    };
  }

  /**
   * Strict variant of resolveContentRootFromAssistantNode used for bookmark lookup.
   * In long conversations ChatGPT virtualizes off-screen turns: the wrapper element may
   * still exist but with no rendered text. Such a shell must be treated as "not mounted"
   * (null) -- never promoted to a huge ancestor, which would contain unrelated messages.
   */
  function resolveRenderedContentRoot(node) {
    if (!node) return null;
    if ((node.textContent || '').trim().length > 0) return node;
    const turn = node.closest(TURN_CONTAINER_QUERY);
    if (turn && (turn.textContent || '').trim().length > 0) return turn;
    return null;
  }

  /**
   * EVERY rendered container that carries any of the bookmark's identifiers (message id, turn key,
   * unit key, test id) -- not just the first match. Pages can contain several elements with the
   * same id (wrappers, previews, duplicates); trusting document.querySelector's first hit made the
   * wrong element win and produced false "edited or regenerated" errors. The caller decides which
   * candidate really contains the passage by matching the text.
   * Empty virtualized shells are skipped (they count as "not mounted").
   */
  function locateBookmarkCandidates(bookmark) {
    const found = [];
    const push = (el) => {
      if (el && !found.includes(el)) found.push(el);
    };
    const all = (selector) => {
      try {
        return Array.from(document.querySelectorAll(selector));
      } catch {
        return [];
      }
    };
    const addNode = (node) => {
      push(resolveRenderedContentRoot(node));
      const turn = node.closest(TURN_CONTAINER_QUERY);
      if (turn && (turn.textContent || '').trim().length > 0) push(turn);
    };

    if (!bookmark) return found;

    if (bookmark.messageId) {
      // The attribute can hold SEVERAL ids ("idA idB"), and that list can grow or change over
      // time, so match the whole string AND each id on its own.
      const tokens = new Set(
        [bookmark.messageId, ...String(bookmark.messageId).split(/[\s,]+/)].filter(Boolean)
      );
      for (const token of tokens) {
        const id = CSS.escape(token);
        for (const n of all(
          `[data-chatgpt-search-message-ids~="${id}"], [data-chatgpt-search-message-ids*="${id}"], [data-message-id="${id}"]`
        )) {
          addNode(n);
        }
      }
    }
    if (bookmark.turnKey) {
      for (const n of all(`[data-turn-key="${CSS.escape(bookmark.turnKey)}"]`)) {
        const inner = n.querySelector(ASSISTANT_UNIT_QUERY);
        push(resolveRenderedContentRoot(inner || n));
      }
    }
    if (bookmark.searchUnitKey) {
      const key = CSS.escape(bookmark.searchUnitKey);
      for (const n of all(
        `[data-chatgpt-search-unit-key="${key}"], [data-content-search-unit-key="${key}"]`
      )) {
        addNode(n);
      }
    }
    if (bookmark.turnTestId && bookmark.turnTestId !== 'app-shell-header-context-menu-surface') {
      for (const n of all(`[data-testid="${CSS.escape(bookmark.turnTestId)}"]`)) addNode(n);
    }
    return found;
  }

  /**
   * Locates the target assistant response container in the current DOM using stored metadata.
   *
   * Returns null when the message is not currently mounted (e.g. virtualized away in a very
   * long conversation). Callers should scroll the conversation to force it to render and retry.
   *
   * NOTE: there is deliberately NO "assistant turn index" fallback. turnIndex is only the
   * position within the *currently mounted* window of messages, so in long chats it points at an
   * unrelated response and produced false "edited or regenerated" errors.
   */
  function locateAssistantMessage(bookmark) {
    if (!bookmark) return null;

    // 1. Primary lookup by data-chatgpt-search-message-ids or data-message-id
    if (bookmark.messageId) {
      const escapedId = CSS.escape(bookmark.messageId);
      const bySearchMsgId = document.querySelector(
        `[data-chatgpt-search-message-ids="${escapedId}"], [data-chatgpt-search-message-ids*="${escapedId}"], [data-message-id="${escapedId}"]`
      );
      if (bySearchMsgId) {
        const resolved = resolveRenderedContentRoot(bySearchMsgId);
        if (resolved) return resolved;
      }
    }

    // 2. Lookup by data-turn-key
    if (bookmark.turnKey) {
      const escapedTurnKey = CSS.escape(bookmark.turnKey);
      const byTurnKey = document.querySelector(`[data-turn-key="${escapedTurnKey}"]`);
      if (byTurnKey) {
        const innerAssistant = byTurnKey.querySelector(ASSISTANT_UNIT_QUERY);
        const resolved = resolveRenderedContentRoot(innerAssistant || byTurnKey);
        if (resolved) return resolved;
      }
    }

    // 3. Lookup by data-chatgpt-search-unit-key or data-content-search-unit-key
    if (bookmark.searchUnitKey) {
      const escapedUnitKey = CSS.escape(bookmark.searchUnitKey);
      const byUnitKey = document.querySelector(
        `[data-chatgpt-search-unit-key="${escapedUnitKey}"], [data-content-search-unit-key="${escapedUnitKey}"]`
      );
      if (byUnitKey) {
        const resolved = resolveRenderedContentRoot(byUnitKey);
        if (resolved) return resolved;
      }
    }

    // 4. Lookup by legacy data-testid
    if (bookmark.turnTestId && bookmark.turnTestId !== 'app-shell-header-context-menu-surface') {
      const escapedTestId = CSS.escape(bookmark.turnTestId);
      const byTurnId = document.querySelector(`[data-testid="${escapedTestId}"]`);
      if (byTurnId) {
        const resolved = resolveRenderedContentRoot(byTurnId);
        if (resolved) return resolved;
      }
    }

    return null;
  }

  /**
   * Assistant messages that are actually rendered right now (non-empty text). Unlike
   * getAllAssistantMessages() this never promotes empty virtualized shells to a large ancestor,
   * so element rects are trustworthy for measuring how much of the chat is currently mounted.
   */
  function getRenderedAssistantMessages() {
    const out = [];
    for (const node of document.querySelectorAll(ASSISTANT_UNIT_QUERY)) {
      const el = resolveRenderedContentRoot(node);
      if (!el) continue;
      if (out.some((o) => o === el || o.contains(el) || el.contains(o))) continue;
      out.push(el);
    }
    return out;
  }

  /**
   * Any rendered conversation turn/message (user or assistant) with text. Used to tell whether
   * the visible viewport is actually populated or still blank because ChatGPT has not mounted
   * the messages for that scroll position yet.
   */
  function getRenderedTurnElements() {
    const query = [TURN_CONTAINER_QUERY, ASSISTANT_UNIT_QUERY, USER_UNIT_QUERY].join(', ');
    return Array.from(document.querySelectorAll(query)).filter(
      (el) => (el.textContent || '').trim().length > 0 && !el.closest('[data-cgpt-bm-ui="true"]')
    );
  }

  /**
   * Finds the scrollable ancestor container that holds the conversation messages.
   * Prioritizes ChatGPT's [data-mcp-app-scroll-host="true"] and [data-app-action-timeline-scroll].
   */
  function findScrollContainer(element) {
    if (element) {
      const explicitAncestorScrollHost = element.closest(SCROLL_HOST_QUERY);
      if (explicitAncestorScrollHost) {
        return explicitAncestorScrollHost;
      }
    }

    let current = element ? element.parentElement : null;
    while (current && current !== document.body && current !== document.documentElement) {
      const style = window.getComputedStyle(current);
      const overflowY = style.overflowY;
      if (
        (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') &&
        current.scrollHeight > current.clientHeight + 10
      ) {
        return current;
      }
      current = current.parentElement;
    }

    const globalScrollHost = document.querySelector(SCROLL_HOST_QUERY);
    if (globalScrollHost) {
      return globalScrollHost;
    }

    return document.scrollingElement || document.documentElement;
  }

  /**
   * Detects whether ChatGPT is currently in dark mode.
   */
  function isDarkMode() {
    const html = document.documentElement;
    if (html.classList.contains('dark')) return true;
    if (html.classList.contains('light')) return false;
    if (html.getAttribute('data-theme') === 'dark') return true;
    if (html.style.colorScheme === 'dark') return true;

    const bodyBg = window.getComputedStyle(document.body).backgroundColor;
    const rgb = bodyBg.match(/\d+/g);
    if (rgb && rgb.length >= 3) {
      const luminance =
        (0.299 * Number(rgb[0]) + 0.587 * Number(rgb[1]) + 0.114 * Number(rgb[2])) / 255;
      return luminance < 0.45;
    }
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  window.CGPTBookmarkerSelectors = {
    SELECTORS,
    getConversationId,
    getUrlChatId,
    getMountedMessageIds,
    getConversationTitle,
    getAllAssistantMessages,
    getRenderedAssistantMessages,
    getRenderedTurnElements,
    findEnclosingAssistantMessage,
    getAssistantMessageMeta,
    locateAssistantMessage,
    locateBookmarkCandidates,
    findScrollContainer,
    isDarkMode
  };
})();
