/**
 * ChatGPT Text Bookmarker — Content Script Controller (v1.4)
 *
 * Manages:
 * 1. Capture-phase mouseup/pointerup & debounced selectionchange detection inside
 *    ChatGPT's [data-conversation-role="assistant"] and [data-d-text-flow] responses
 * 2. Floating one-click bookmark icon positioned near the selection
 * 3. Compact bookmark sidebar with [This Chat] / [All Chats] toggle
 * 4. Smooth centered scroll navigation on [data-mcp-app-scroll-host] & 3s amber-gold pulse
 * 5. Cross-conversation jump resumption & edited/regenerated response toast guard
 */
(function () {
  'use strict';

  if (window.__CGPT_TEXT_BOOKMARKER_LOADED__) return;
  window.__CGPT_TEXT_BOOKMARKER_LOADED__ = true;

  const {
    getUrlChatId,
    getMountedMessageIds,
    getConversationTitle,
    getAllAssistantMessages,
    getRenderedAssistantMessages,
    getRenderedTurnElements,
    findEnclosingAssistantMessage,
    locateAssistantMessage,
    locateBookmarkCandidates,
    findScrollContainer,
    isDarkMode
  } = window.CGPTBookmarkerSelectors;

  const {
    getAllBookmarks,
    getLibrary,
    saveBookmark,
    updateBookmarks,
    moveBookmarkToChat,
    deleteBookmark,
    createCollection,
    renameCollection,
    deleteCollection,
    addToCollection,
    removeFromCollection,
    setSetting,
    getSetting,
    onBookmarksChanged,
    exportAll,
    importBookmarks,
    setPendingJump,
    consumePendingJump
  } = window.CGPTBookmarkerStorage;

  const {
    SESSION_ID,
    createIdentityTracker,
    computeIdentityPatches
  } = window.CGPTBookmarkerIdentity;

  // Decides when the URL's chat id and the messages on screen can both be trusted (see identity.js).
  const identityTracker = createIdentityTracker({
    getUrlChatId,
    getMountedIds: getMountedMessageIds,
    getTitle: getConversationTitle
  });

  const {
    createBookmarkAnchor,
    resolveBookmarkRange
  } = window.CGPTBookmarkerAnchorEngine;

  function isRootScroller(el) {
    return el === document.documentElement || el === document.body || el === document.scrollingElement;
  }

  /**
   * Converts a viewport Y coordinate to a Y coordinate inside the scroller's scrollable content.
   * (For the page root, getBoundingClientRect().top already reflects the scroll offset, so the
   * viewport Y plus scrollTop is the content Y; for an inner scroller subtract its own top.)
   */
  function viewportToContentY(scroller, viewportY) {
    if (isRootScroller(scroller)) return viewportY + scroller.scrollTop;
    return viewportY - scroller.getBoundingClientRect().top + scroller.scrollTop;
  }

  // UI & Runtime State
  let activeSelectionRange = null;
  let activeAssistantEl = null;
  let isSidebarOpen = false;
  let sidebarScope = 'current'; // 'current' | 'all'
  let currentConversationId = getUrlChatId(); // null on a new / unsaved chat

  /**
   * Does this bookmark belong to the chat being viewed? Membership is a set of chat ids (it grows
   * as the bookmark's message is observed in a chat). On a not-yet-saved chat ("/"), only bookmarks
   * made in this very page session and not yet linked to any chat belong here.
   */
  function belongsToCurrentChat(bm) {
    if (currentConversationId) return bm.conversationIds.includes(currentConversationId);
    return bm.conversationIds.length === 0 && bm.sessionId === SESSION_ID;
  }

  function otherChatLabel(bm) {
    if (bm.conversationIds.length === 0) return 'Not linked to a chat yet';
    const title = (bm.conversationTitle || '').trim();
    if (!title || title === 'ChatGPT Conversation') return 'Other chat';
    return 'Other chat: ' + (title.length > 26 ? title.slice(0, 25) + '…' : title);
  }
  let selectionDebounceTimer = null;
  let highlightCleanupTimer = null;
  let highlightRafId = null;
  let toastTimeoutId = null;

  // DOM References
  let rootContainer = null;
  let floatingBtn = null;
  let togglePillBtn = null;
  let countBadgeEl = null;
  let sidebarEl = null;
  let bookmarkListEl = null;
  let scopeCurrentBtn = null;
  let scopeAllBtn = null;
  let highlightLayerEl = null;
  let toastEl = null;

  function createExtensionUI() {
    rootContainer = document.createElement('div');
    rootContainer.id = 'cgpt-bm-root';
    rootContainer.setAttribute('data-cgpt-bm-ui', 'true');
    syncThemeClass();

    // 1. Non-destructive highlight overlay layer
    highlightLayerEl = document.createElement('div');
    highlightLayerEl.className = 'cgpt-bm-highlight-layer';
    highlightLayerEl.setAttribute('data-cgpt-bm-ui', 'true');

    // 2. Floating bookmark icon near selected text
    floatingBtn = document.createElement('button');
    floatingBtn.type = 'button';
    floatingBtn.className = 'cgpt-bm-floating-btn';
    floatingBtn.setAttribute('data-cgpt-bm-ui', 'true');
    floatingBtn.setAttribute('aria-label', 'Bookmark selected passage');
    floatingBtn.title = 'Bookmark selected text';
    floatingBtn.innerHTML = `
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"></path>
      </svg>
      <span>Bookmark</span>
    `;

    // Prevent pointerdown/mousedown from collapsing the user's current text selection
    floatingBtn.addEventListener(
      'pointerdown',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
      },
      true
    );
    floatingBtn.addEventListener(
      'mousedown',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
      },
      true
    );
    floatingBtn.addEventListener('click', handleFloatingBookmarkClick, true);

    // 3. Persistent bookmark sidebar toggle button
    togglePillBtn = document.createElement('button');
    togglePillBtn.type = 'button';
    togglePillBtn.className = 'cgpt-bm-toggle-btn';
    togglePillBtn.setAttribute('data-cgpt-bm-ui', 'true');
    togglePillBtn.setAttribute('aria-label', 'Open Pinpoint bookmarks');
    togglePillBtn.title = 'Pinpoint Bookmarks';
    togglePillBtn.innerHTML = `
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"></path>
      </svg>
      <span class="cgpt-bm-toggle-label">Bookmarks</span>
      <span class="cgpt-bm-toggle-count" id="cgpt-bm-count">0</span>
      <span class="cgpt-bm-toggle-dot" data-status="unknown" title="Page check needs attention" hidden></span>
    `;
    togglePillBtn.addEventListener('click', () => {
      toggleSidebar();
    });

    // 4. Sidebar panel: header (title, scope tabs, search, collections), toolbar, list, page-check row
    sidebarEl = document.createElement('aside');
    sidebarEl.className = 'cgpt-bm-sidebar';
    sidebarEl.setAttribute('data-cgpt-bm-ui', 'true');
    sidebarEl.setAttribute('aria-label', 'Pinpoint Bookmarks');
    sidebarEl.innerHTML = `
      <div class="cgpt-bm-sidebar-header">
        <div class="cgpt-bm-sidebar-title-row">
          <div class="cgpt-bm-sidebar-title">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"></path>
            </svg>
            <span>Pinpoint</span>
          </div>
          <div class="cgpt-bm-header-actions">
            <button type="button" class="cgpt-bm-icon-btn" data-action="menu" aria-label="More options" aria-haspopup="menu" aria-expanded="false" title="Backup, restore and troubleshooting">${ICONS.kebab}</button>
            <button type="button" class="cgpt-bm-icon-btn cgpt-bm-close-btn" aria-label="Close bookmarks sidebar" title="Close">${ICONS.close}</button>
          </div>
        </div>
        <div class="cgpt-bm-scope-tabs" role="tablist">
          <button type="button" class="cgpt-bm-scope-tab is-active" data-scope="current" role="tab" aria-selected="true">
            This Chat
          </button>
          <button type="button" class="cgpt-bm-scope-tab" data-scope="all" role="tab" aria-selected="false">
            All Chats
          </button>
        </div>
        <div class="cgpt-bm-search">
          <span class="cgpt-bm-search-icon">${ICONS.search}</span>
          <input type="text" class="cgpt-bm-search-input" placeholder="Search bookmarks" aria-label="Search bookmarks" autocomplete="off" spellcheck="false">
          <button type="button" class="cgpt-bm-search-clear" aria-label="Clear search" title="Clear" hidden>${ICONS.close.replace('width="16" height="16"', 'width="12" height="12"')}</button>
        </div>
        <div class="cgpt-bm-collections" aria-label="Collections" hidden></div>
      </div>
      <div class="cgpt-bm-toolbar">
        <span class="cgpt-bm-result-count" aria-live="polite"></span>
        <div class="cgpt-bm-toolbar-actions">
          <button type="button" class="cgpt-bm-text-btn" data-action="rename-collection" hidden>Rename</button>
          <button type="button" class="cgpt-bm-text-btn is-danger" data-action="delete-collection" hidden>Delete collection</button>
          <button type="button" class="cgpt-bm-text-btn" data-action="group" aria-pressed="false" title="Group the list by chat" hidden>Group by chat</button>
        </div>
      </div>
      <div class="cgpt-bm-sidebar-list" id="cgpt-bm-list"></div>
      <button type="button" class="cgpt-bm-health-row" data-action="health" title="Check that the extension still works with the current ChatGPT page">
        <span class="cgpt-bm-health-dot" data-status="unknown"></span>
        <span class="cgpt-bm-health-text">Page check</span>
        <span class="cgpt-bm-health-meta"></span>
      </button>
      <div class="cgpt-bm-menu" role="menu" hidden>
        <button type="button" class="cgpt-bm-menu-item" role="menuitem" data-action="export" title="Download all bookmarks and collections as a backup file">Export backup</button>
        <button type="button" class="cgpt-bm-menu-item" role="menuitem" data-action="import" title="Restore from a backup file (nothing is overwritten)">Import backup…</button>
        <div class="cgpt-bm-menu-sep" role="separator"></div>
        <button type="button" class="cgpt-bm-menu-item" role="menuitem" data-action="debug" title="Copy technical info about the last bookmark jump (contains no chat text)">Copy debug info</button>
      </div>
      <input type="file" accept="application/json,.json" hidden data-action="import-file">
      <div class="cgpt-bm-panel" hidden></div>
    `;

    // 5. Notification Toast for missing/edited passages
    toastEl = document.createElement('div');
    toastEl.className = 'cgpt-bm-toast';
    toastEl.setAttribute('data-cgpt-bm-ui', 'true');
    toastEl.setAttribute('role', 'status');
    toastEl.setAttribute('aria-live', 'polite');

    rootContainer.appendChild(highlightLayerEl);
    rootContainer.appendChild(floatingBtn);
    rootContainer.appendChild(togglePillBtn);
    rootContainer.appendChild(sidebarEl);
    rootContainer.appendChild(toastEl);
    document.body.appendChild(rootContainer);

    countBadgeEl = togglePillBtn.querySelector('#cgpt-bm-count');
    toggleDotEl = togglePillBtn.querySelector('.cgpt-bm-toggle-dot');
    bookmarkListEl = sidebarEl.querySelector('#cgpt-bm-list');
    scopeCurrentBtn = sidebarEl.querySelector('[data-scope="current"]');
    scopeAllBtn = sidebarEl.querySelector('[data-scope="all"]');
    searchInputEl = sidebarEl.querySelector('.cgpt-bm-search-input');
    searchClearEl = sidebarEl.querySelector('.cgpt-bm-search-clear');
    chipsEl = sidebarEl.querySelector('.cgpt-bm-collections');
    resultCountEl = sidebarEl.querySelector('.cgpt-bm-result-count');
    groupBtnEl = sidebarEl.querySelector('[data-action="group"]');
    renameColBtnEl = sidebarEl.querySelector('[data-action="rename-collection"]');
    deleteColBtnEl = sidebarEl.querySelector('[data-action="delete-collection"]');
    healthRowEl = sidebarEl.querySelector('.cgpt-bm-health-row');
    menuEl = sidebarEl.querySelector('.cgpt-bm-menu');
    panelEl = sidebarEl.querySelector('.cgpt-bm-panel');

    sidebarEl.querySelector('.cgpt-bm-close-btn').addEventListener('click', () => toggleSidebar(false));
    scopeCurrentBtn.addEventListener('click', () => setSidebarScope('current'));
    scopeAllBtn.addEventListener('click', () => setSidebarScope('all'));

    // Search (in memory only: typing never touches storage)
    searchInputEl.addEventListener('input', () => {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        searchQuery = searchInputEl.value;
        searchClearEl.hidden = !searchQuery;
        renderAllItems = false;
        renderBookmarkItems();
      }, 120);
    });
    searchInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && searchInputEl.value) {
        e.stopPropagation();
        clearSearch();
      }
    });
    searchClearEl.addEventListener('click', () => {
      clearSearch();
      searchInputEl.focus();
    });

    groupBtnEl.addEventListener('click', toggleGroupByChat);
    renameColBtnEl.addEventListener('click', startRenameActiveCollection);
    deleteColBtnEl.addEventListener('click', deleteActiveCollection);
    healthRowEl.addEventListener('click', openHealthPanel);

    // "More" menu + backup actions
    const kebabBtn = sidebarEl.querySelector('[data-action="menu"]');
    const importFileInput = sidebarEl.querySelector('[data-action="import-file"]');
    kebabBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const opening = menuEl.hidden;
      closeFloating();
      menuEl.hidden = !opening;
      kebabBtn.setAttribute('aria-expanded', String(opening));
    });
    menuEl.querySelector('[data-action="export"]').addEventListener('click', () => {
      closeFloating();
      handleExportBackup();
    });
    menuEl.querySelector('[data-action="import"]').addEventListener('click', () => {
      closeFloating();
      importFileInput.click();
    });
    menuEl.querySelector('[data-action="debug"]').addEventListener('click', () => {
      closeFloating();
      handleCopyDiagnostics();
    });
    importFileInput.addEventListener('change', async () => {
      const file = importFileInput.files && importFileInput.files[0];
      importFileInput.value = '';
      if (file) await handleImportBackup(file);
    });

    // Close menus / popovers on outside click and Escape
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (!sidebarEl) return;
        const insideFloating =
          (floatingPopoverEl && floatingPopoverEl.contains(e.target)) ||
          (!menuEl.hidden && menuEl.contains(e.target)) ||
          kebabBtn.contains(e.target) ||
          (e.target.closest && e.target.closest('.cgpt-bm-collections-btn'));
        if (!insideFloating) closeFloating();
      },
      true
    );
    sidebarEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (floatingPopoverEl || !menuEl.hidden) {
        closeFloating();
        e.stopPropagation();
      } else if (!panelEl.hidden) {
        closeHealthPanel();
        e.stopPropagation();
      }
    });
  }

  /** Structural facts only (element types, sizes, counts, step log). No chat or passage text. */
  function buildDiagnostics() {
    const ref = getRenderedAssistantMessages()[0] || null;
    let version = '';
    try {
      version = chrome.runtime.getManifest().version;
    } catch {
      // ignore
    }
    return {
      extensionVersion: version,
      collectedAt: new Date().toISOString(),
      pagePath: window.location.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{20,}/gi, '<id>'),
      counts: {
        assistantMessagesDetected: getAllAssistantMessages().length,
        assistantMessagesRendered: getRenderedAssistantMessages().length,
        turnsRendered: getRenderedTurnElements().length,
        messageIdsMounted: getMountedMessageIds().size
      },
      scrollCandidates: probeScrollers(ref).map((p) => ({
        ...describeEl(p.el),
        scrollable: p.scrollable,
        movesMessages: p.moved
      })),
      recentJumps: debugState.history,
      lastJump: debugState.jump
    };
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('data-cgpt-bm-ui', 'true');
      area.style.cssText = 'position:fixed;left:-9999px;top:0;';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
  }

  async function handleCopyDiagnostics() {
    await copyToClipboard(JSON.stringify(buildDiagnostics(), null, 2));
    showToast('Debug info copied (contains no chat text).', 'success');
  }

  async function handleExportBackup() {
    try {
      const data = await exportAll();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `chatgpt-bookmarks-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      showToast(`Exported ${data.count} bookmark${data.count === 1 ? '' : 's'}.`, 'success');
    } catch (err) {
      showToast('Export failed: ' + (err && err.message ? err.message : err), 'warning', 6000);
    }
  }

  async function handleImportBackup(file) {
    try {
      const payload = JSON.parse(await file.text());
      const res = await importBookmarks(payload);
      await refreshBookmarkList();
      const parts = [`${res.added} added`];
      if (res.merged) parts.push(`${res.merged} re-linked`);
      if (res.collectionsAdded) parts.push(`${res.collectionsAdded} collection${res.collectionsAdded === 1 ? '' : 's'}`);
      if (res.skipped) parts.push(`${res.skipped} already present`);
      if (res.invalid) parts.push(`${res.invalid} unreadable`);
      showToast('Import finished: ' + parts.join(', ') + '.', 'success', 5000);
    } catch (err) {
      showToast('Import failed: ' + (err && err.message ? err.message : err), 'warning', 6000);
    }
  }

  function syncThemeClass() {
    if (!rootContainer) return;
    const dark = isDarkMode();
    rootContainer.classList.toggle('cgpt-bm-dark', dark);
    rootContainer.classList.toggle('cgpt-bm-light', !dark);
  }

  function toggleSidebar(forceState) {
    isSidebarOpen = typeof forceState === 'boolean' ? forceState : !isSidebarOpen;
    if (sidebarEl) {
      sidebarEl.classList.toggle('is-open', isSidebarOpen);
    }
    if (togglePillBtn) {
      togglePillBtn.classList.toggle('is-active', isSidebarOpen);
    }
    if (isSidebarOpen) {
      refreshBookmarkList();
    }
  }

  /**
   * durationMs = 0 keeps the toast visible until hideToast() / the next showToast().
   */
  function showToast(message, variant = 'info', durationMs = 3400) {
    if (!toastEl) return;
    if (toastTimeoutId) clearTimeout(toastTimeoutId);

    toastEl.textContent = message;
    toastEl.className = `cgpt-bm-toast is-visible is-${variant}`;
    if (durationMs > 0) {
      toastTimeoutId = setTimeout(() => {
        toastEl.classList.remove('is-visible');
      }, durationMs);
    }
  }

  function hideToast() {
    if (toastTimeoutId) clearTimeout(toastTimeoutId);
    if (toastEl) toastEl.classList.remove('is-visible');
  }

  /**
   * Validates the current browser Selection and displays or hides the floating bookmark button.
   */
  function evaluateCurrentSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      hideFloatingButton();
      return;
    }

    const text = selection.toString();
    if (!text || text.trim().length < 2) {
      hideFloatingButton();
      return;
    }

    const range = selection.getRangeAt(0);

    // Ensure neither anchor nor focus is inside our extension UI
    const startEl =
      range.startContainer.nodeType === Node.ELEMENT_NODE
        ? range.startContainer
        : range.startContainer.parentElement;
    const endEl =
      range.endContainer.nodeType === Node.ELEMENT_NODE
        ? range.endContainer
        : range.endContainer.parentElement;

    if (
      (startEl && startEl.closest('[data-cgpt-bm-ui="true"]')) ||
      (endEl && endEl.closest('[data-cgpt-bm-ui="true"]'))
    ) {
      return;
    }

    const startAssistant = findEnclosingAssistantMessage(range.startContainer);
    const endAssistant = findEnclosingAssistantMessage(range.endContainer);

    let resolvedAssistantEl = null;

    if (startAssistant && endAssistant) {
      if (startAssistant === endAssistant) {
        resolvedAssistantEl = startAssistant;
      } else if (startAssistant.contains(endAssistant)) {
        resolvedAssistantEl = startAssistant;
      } else if (endAssistant.contains(startAssistant)) {
        resolvedAssistantEl = endAssistant;
      } else {
        // Check if both belong to the same [data-turn-key] turn container
        const startTurn = startAssistant.closest('[data-turn-key]');
        const endTurn = endAssistant.closest('[data-turn-key]');
        if (startTurn && startTurn === endTurn) {
          resolvedAssistantEl = startTurn;
        }
      }
    } else if (startAssistant && !endAssistant) {
      // Triple-click selection often places endContainer at offset 0 of the following sibling block
      if (range.endOffset === 0) {
        resolvedAssistantEl = startAssistant;
      }
    }

    if (!resolvedAssistantEl) {
      hideFloatingButton();
      return;
    }

    const rawRects = Array.from(range.getClientRects()).filter(
      (r) => r.width > 0 && r.height > 0
    );
    const boundingRect = range.getBoundingClientRect();
    if (rawRects.length === 0 && boundingRect.width === 0 && boundingRect.height === 0) {
      hideFloatingButton();
      return;
    }

    activeSelectionRange = range.cloneRange();
    activeAssistantEl = resolvedAssistantEl;

    const anchorRect = rawRects.length > 0 ? rawRects[rawRects.length - 1] : boundingRect;
    positionFloatingButton(anchorRect, boundingRect);
  }

  /**
   * Positions the floating bookmark button near the selected text, clamped inside the viewport.
   */
  function positionFloatingButton(lastRect, boundingRect) {
    if (!floatingBtn) return;

    const btnWidth = 104;
    const btnHeight = 32;
    const margin = 8;

    let top = lastRect.top - btnHeight - margin;
    if (top < 12) {
      top = Math.min(window.innerHeight - btnHeight - 12, boundingRect.bottom + margin);
    }

    let left = lastRect.right - btnWidth / 2;
    left = Math.max(12, Math.min(window.innerWidth - btnWidth - 12, left));

    floatingBtn.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
    floatingBtn.classList.add('is-visible');
  }

  function hideFloatingButton() {
    activeSelectionRange = null;
    activeAssistantEl = null;
    if (floatingBtn) {
      floatingBtn.classList.remove('is-visible');
    }
  }

  /**
   * Saves the active selection as a persistent text bookmark when the floating icon is clicked.
   */
  async function handleFloatingBookmarkClick(e) {
    e.preventDefault();
    e.stopPropagation();

    if (!activeSelectionRange || !activeAssistantEl) {
      hideFloatingButton();
      return;
    }

    const savedRange = activeSelectionRange;
    const savedAssistantEl = activeAssistantEl;

    // Never trust the URL blindly: right after opening another chat the URL changes first while
    // the previous chat's messages are still on screen, and a bookmark made now would be filed
    // under the wrong chat. Wait until URL and on-screen messages agree.
    const identity = identityTracker.poll();
    if (identity.urlId !== null && !identity.strong && !identity.weak) {
      showToast('This chat is still loading - wait a second, then bookmark again.', 'warning');
      return;
    }

    const anchor = createBookmarkAnchor(savedRange, savedAssistantEl);
    if (!anchor) {
      showToast('Could not capture the selected text passage.', 'warning');
      hideFloatingButton();
      return;
    }

    // Remember roughly where in the scroller this passage lives, so that in very long
    // (virtualized) chats we can later start looking for it in the right neighbourhood.
    try {
      const scroller = findWorkingScroller(savedAssistantEl);
      const rangeRect = savedRange.getBoundingClientRect();
      const absY = viewportToContentY(scroller, rangeRect.top);
      anchor.scrollOffsetPx = Math.max(0, Math.round(absY));
      anchor.scrollRatio = scroller.scrollHeight > 0 ? absY / scroller.scrollHeight : null;
    } catch {
      // Hint is optional
    }

    anchor.sessionId = SESSION_ID;

    let bookmark;
    let isDuplicate;
    try {
      ({ bookmark, isDuplicate } = await saveBookmark(anchor));
    } catch (err) {
      console.error('[ChatGPT Text Bookmarker] Save failed:', err);
      showToast('Could not save the bookmark: ' + (err && err.message ? err.message : err), 'warning', 6000);
      return;
    }

    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    hideFloatingButton();

    await refreshBookmarkList();

    if (isDuplicate) {
      showToast('This passage is already bookmarked.', 'info');
    } else {
      showToast('Passage bookmarked.', 'success');
    }

    if (bookmark) {
      const resolved = resolveBookmarkRange(bookmark, savedAssistantEl);
      if (resolved.status === 'resolved' && resolved.range) {
        renderTemporaryHighlight(resolved.range);
      }
    }
  }

  // ===========================================================================
  // Sidebar: list, search, collections, grouping, page check
  // (UI only. It reads bookmarks through the storage layer and never touches the jump/search logic.)
  // ===========================================================================

  const svgIcon = (inner, size = 14) =>
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

  const ICONS = {
    kebab: svgIcon('<circle cx="12" cy="5" r="1"></circle><circle cx="12" cy="12" r="1"></circle><circle cx="12" cy="19" r="1"></circle>', 16),
    close: svgIcon('<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>', 16),
    search: svgIcon('<circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>'),
    folderPlus: svgIcon('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><line x1="12" y1="11" x2="12" y2="15"></line><line x1="10" y1="13" x2="14" y2="13"></line>'),
    trash: svgIcon('<polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>'),
    chevron: svgIcon('<polyline points="6 9 12 15 18 9"></polyline>'),
    check: svgIcon('<polyline points="20 6 9 17 4 12"></polyline>', 13),
    back: svgIcon('<polyline points="15 18 9 12 15 6"></polyline>', 16)
  };

  let toggleDotEl = null;
  let searchInputEl = null;
  let searchClearEl = null;
  let chipsEl = null;
  let resultCountEl = null;
  let groupBtnEl = null;
  let renameColBtnEl = null;
  let deleteColBtnEl = null;
  let healthRowEl = null;
  let menuEl = null;
  let panelEl = null;
  let floatingPopoverEl = null;

  let activeCollectionId = null; // null = all bookmarks
  let searchQuery = '';
  let groupByChat = false;
  let renderAllItems = false;
  let searchDebounceTimer = null;
  let deleteArmTimer = null;
  let libraryCache = { bookmarks: [], collections: [] };
  const collapsedGroups = new Set();
  const RENDER_CAP = 200; // very long lists render the newest 200 first; "Show all" renders the rest

  const errText = (err) => (err && err.message ? err.message : String(err));

  function setSidebarScope(scope) {
    sidebarScope = scope;
    closeFloating();
    if (scopeCurrentBtn && scopeAllBtn) {
      const isCurrent = scope === 'current';
      scopeCurrentBtn.classList.toggle('is-active', isCurrent);
      scopeCurrentBtn.setAttribute('aria-selected', String(isCurrent));
      scopeAllBtn.classList.toggle('is-active', !isCurrent);
      scopeAllBtn.setAttribute('aria-selected', String(!isCurrent));
    }
    renderAllItems = false;
    refreshBookmarkList();
  }

  function clearSearch() {
    clearTimeout(searchDebounceTimer);
    if (searchInputEl) searchInputEl.value = '';
    searchQuery = '';
    if (searchClearEl) searchClearEl.hidden = true;
    renderAllItems = false;
    renderBookmarkItems();
  }

  // ---- data -> screen -------------------------------------------------------------------------

  /** Reads bookmarks + collections (ONE storage read), then redraws. */
  async function refreshBookmarkList() {
    if (!bookmarkListEl) return;

    currentConversationId = getUrlChatId();
    let library;
    try {
      library = await getLibrary();
    } catch (err) {
      console.warn('[ChatGPT Text Bookmarker] Could not read bookmarks:', err);
      showToast('Could not read your bookmarks: ' + errText(err), 'warning', 6000);
      return;
    }
    libraryCache = library;

    const currentChatBookmarks = library.bookmarks.filter(belongsToCurrentChat);
    if (countBadgeEl) countBadgeEl.textContent = String(currentChatBookmarks.length);
    if (scopeCurrentBtn) scopeCurrentBtn.textContent = `This Chat (${currentChatBookmarks.length})`;
    if (scopeAllBtn) scopeAllBtn.textContent = `All Chats (${library.bookmarks.length})`;

    if (activeCollectionId && !library.collections.some((c) => c.id === activeCollectionId)) {
      activeCollectionId = null; // it was deleted (possibly in another tab)
    }
    renderCollectionsBar();
    renderBookmarkItems();
  }

  /** Redraws the list from the in-memory library (used by search, filters and grouping). */
  function renderBookmarkItems() {
    if (!bookmarkListEl) return;
    const { bookmarks: all, collections } = libraryCache;
    const current = all.filter(belongsToCurrentChat);

    const collectionsByBookmark = new Map();
    for (const col of collections) {
      for (const id of col.bookmarkIds) {
        if (!collectionsByBookmark.has(id)) collectionsByBookmark.set(id, []);
        collectionsByBookmark.get(id).push(col);
      }
    }

    const inAllScope = sidebarScope === 'all';
    const activeCol = inAllScope && activeCollectionId ? collections.find((c) => c.id === activeCollectionId) : null;

    let base = inAllScope ? all : current;
    if (activeCol) {
      const members = new Set(activeCol.bookmarkIds);
      base = base.filter((bm) => members.has(bm.id));
    }

    const terms = searchQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let displayed = base;
    if (terms.length > 0) {
      displayed = base.filter((bm) => {
        const names = (collectionsByBookmark.get(bm.id) || []).map((c) => c.name).join(' ');
        const haystack = `${bm.selectedText || ''} ${bm.conversationTitle || ''} ${names}`.toLowerCase();
        return terms.every((term) => haystack.includes(term));
      });
    }

    // toolbar
    if (resultCountEl) {
      const noun = base.length === 1 ? 'bookmark' : 'bookmarks'; // follows the total: "1 of 3 bookmarks"
      resultCountEl.textContent =
        displayed.length === base.length ? `${displayed.length} ${noun}` : `${displayed.length} of ${base.length} ${noun}`;
    }
    if (groupBtnEl) {
      groupBtnEl.hidden = !inAllScope;
      groupBtnEl.setAttribute('aria-pressed', String(groupByChat));
      groupBtnEl.classList.toggle('is-on', groupByChat);
    }
    if (renameColBtnEl) renameColBtnEl.hidden = !activeCol;
    if (deleteColBtnEl) {
      deleteColBtnEl.hidden = !activeCol;
      if (!deleteColBtnEl.dataset.armed) deleteColBtnEl.textContent = 'Delete collection';
    }

    bookmarkListEl.innerHTML = '';

    if (displayed.length === 0) {
      bookmarkListEl.appendChild(buildEmptyState({ inAllScope, activeCol, searching: terms.length > 0, totalAll: all.length }));
      return;
    }

    const shown = renderAllItems ? displayed : displayed.slice(0, RENDER_CAP);
    const fragment = document.createDocumentFragment();

    if (groupByChat && inAllScope) {
      appendGroupedItems(fragment, shown, collectionsByBookmark);
    } else {
      for (const bm of shown) fragment.appendChild(buildBookmarkItem(bm, collectionsByBookmark));
    }

    if (shown.length < displayed.length) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'cgpt-bm-show-more';
      more.textContent = `Show all ${displayed.length} bookmarks`;
      more.addEventListener('click', () => {
        renderAllItems = true;
        renderBookmarkItems();
      });
      fragment.appendChild(more);
    }
    bookmarkListEl.appendChild(fragment);
  }

  function buildEmptyState({ inAllScope, activeCol, searching, totalAll }) {
    const el = document.createElement('div');
    el.className = 'cgpt-bm-empty';
    const title = document.createElement('div');
    title.className = 'cgpt-bm-empty-title';
    const desc = document.createElement('div');
    desc.className = 'cgpt-bm-empty-desc';

    if (searching) {
      title.textContent = 'No matching bookmarks';
      desc.textContent = 'Try different words, or clear the search to see everything in this view.';
    } else if (activeCol) {
      title.textContent = `Nothing in “${activeCol.name}” yet`;
      desc.textContent = 'Use the folder button on any bookmark to add it to this collection.';
    } else if (!inAllScope) {
      title.textContent = 'No bookmarks in this chat yet';
      desc.innerHTML =
        'Select any sentence, paragraph, formula, or code inside a ChatGPT response and click the floating <strong>Bookmark</strong> button.';
    } else {
      title.textContent = totalAll === 0 ? 'No saved bookmarks yet' : 'No bookmarks to show';
      desc.innerHTML =
        'Select any sentence, paragraph, formula, or code inside a ChatGPT response and click the floating <strong>Bookmark</strong> button.';
    }
    el.append(title, desc);
    return el;
  }

  function chatGroupKey(bm) {
    return bm.conversationId || bm.conversationIds[0] || 'unlinked';
  }

  function appendGroupedItems(fragment, bookmarks, collectionsByBookmark) {
    const groups = new Map(); // insertion order = most recent bookmark first
    for (const bm of bookmarks) {
      const key = chatGroupKey(bm);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(bm);
    }

    for (const [key, items] of groups) {
      const collapsed = collapsedGroups.has(key);
      const groupEl = document.createElement('section');
      groupEl.className = 'cgpt-bm-group';

      const header = document.createElement('button');
      header.type = 'button';
      header.className = 'cgpt-bm-group-header';
      header.setAttribute('aria-expanded', String(!collapsed));

      const chevron = document.createElement('span');
      chevron.className = 'cgpt-bm-group-chevron';
      chevron.innerHTML = ICONS.chevron;

      const titleEl = document.createElement('span');
      titleEl.className = 'cgpt-bm-group-title';
      const known = items.map((b) => (b.conversationTitle || '').trim()).find((t) => t && t !== 'ChatGPT Conversation');
      titleEl.textContent = key === 'unlinked' ? 'Not linked to a chat yet' : known || 'Untitled chat';

      const count = document.createElement('span');
      count.className = 'cgpt-bm-group-count';
      count.textContent = String(items.length);

      header.append(chevron, titleEl);
      if (key === currentConversationId) {
        const here = document.createElement('span');
        here.className = 'cgpt-bm-group-here';
        here.textContent = 'This chat';
        header.append(here);
      }
      header.append(count);

      const body = document.createElement('div');
      body.className = 'cgpt-bm-group-items';
      body.hidden = collapsed;
      for (const bm of items) body.appendChild(buildBookmarkItem(bm, collectionsByBookmark));

      header.addEventListener('click', () => {
        const nowCollapsed = !collapsedGroups.has(key);
        if (nowCollapsed) collapsedGroups.add(key);
        else collapsedGroups.delete(key);
        body.hidden = nowCollapsed;
        header.setAttribute('aria-expanded', String(!nowCollapsed));
      });

      groupEl.append(header, body);
      fragment.appendChild(groupEl);
    }
  }

  function buildBookmarkItem(bm, collectionsByBookmark) {
    const itemEl = document.createElement('div');
    itemEl.className = 'cgpt-bm-item';
    itemEl.setAttribute('role', 'button');
    itemEl.tabIndex = 0;

    const isOtherChat = !belongsToCurrentChat(bm);
    const turnLabel =
      typeof bm.turnIndex === 'number' && bm.turnIndex >= 0 ? `Response #${bm.turnIndex + 1}` : 'Assistant response';
    const timeLabel = formatRelativeTime(bm.createdAt);

    itemEl.innerHTML = `
      <div class="cgpt-bm-item-body">
        <div class="cgpt-bm-item-quote"></div>
        <div class="cgpt-bm-item-meta">
          <span>${turnLabel}</span>
          <span aria-hidden="true">·</span>
          <span>${timeLabel}</span>
          ${isOtherChat ? '<span aria-hidden="true">·</span><span class="cgpt-bm-other-chat-tag"></span>' : ''}
        </div>
      </div>
      <div class="cgpt-bm-item-actions">
        <button type="button" class="cgpt-bm-icon-btn cgpt-bm-collections-btn" aria-label="Add to collection" aria-haspopup="dialog" title="Add to collection">${ICONS.folderPlus}</button>
        <button type="button" class="cgpt-bm-icon-btn cgpt-bm-delete-btn" aria-label="Delete bookmark" title="Delete bookmark">${ICONS.trash}</button>
      </div>
    `;

    const body = itemEl.querySelector('.cgpt-bm-item-body');
    itemEl.querySelector('.cgpt-bm-item-quote').textContent = bm.selectedText;

    const otherTagEl = itemEl.querySelector('.cgpt-bm-other-chat-tag');
    if (otherTagEl) {
      otherTagEl.textContent = otherChatLabel(bm); // textContent: chat titles are untrusted text
      otherTagEl.title = bm.conversationTitle || '';
    }

    const memberOf = collectionsByBookmark.get(bm.id) || [];
    if (memberOf.length > 0) {
      const badges = document.createElement('div');
      badges.className = 'cgpt-bm-badges';
      for (const col of memberOf.slice(0, 3)) {
        const badge = document.createElement('span');
        badge.className = 'cgpt-bm-badge';
        badge.textContent = col.name;
        badges.appendChild(badge);
      }
      if (memberOf.length > 3) {
        const extra = document.createElement('span');
        extra.className = 'cgpt-bm-badge is-more';
        extra.textContent = `+${memberOf.length - 3}`;
        badges.appendChild(extra);
      }
      body.appendChild(badges);
    }

    // Escape hatch for a bookmark filed under the wrong chat (e.g. made before an earlier fix).
    if (isOtherChat && currentConversationId) {
      const moveBtn = document.createElement('button');
      moveBtn.type = 'button';
      moveBtn.className = 'cgpt-bm-move-btn';
      moveBtn.textContent = 'Move here';
      moveBtn.title = 'File this bookmark under the chat you are viewing now';
      moveBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await moveBookmarkToChat(bm.id, currentConversationId, {
            conversationTitle: getConversationTitle(),
            conversationPath: window.location.pathname
          });
          await refreshBookmarkList();
          showToast('Bookmark moved to this chat.', 'success');
        } catch (err) {
          showToast('Could not move the bookmark: ' + errText(err), 'warning');
        }
      });
      body.appendChild(moveBtn);
    }

    itemEl.querySelector('.cgpt-bm-collections-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openCollectionsPopover(e.currentTarget, bm);
    });

    itemEl.querySelector('.cgpt-bm-delete-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await deleteBookmark(bm.id);
        await refreshBookmarkList();
        showToast('Bookmark removed.', 'info');
      } catch (err) {
        showToast('Could not remove the bookmark: ' + errText(err), 'warning');
      }
    });

    itemEl.addEventListener('click', () => navigateToBookmark(bm));
    itemEl.addEventListener('keydown', (e) => {
      if (e.target !== itemEl) return; // Enter/Space on an inner button must not also jump
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        navigateToBookmark(bm);
      }
    });

    return itemEl;
  }

  // ---- collections bar ------------------------------------------------------------------------

  function renderCollectionsBar() {
    if (!chipsEl) return;
    const inAllScope = sidebarScope === 'all';
    chipsEl.hidden = !inAllScope;
    if (!inAllScope) return;

    // Do not wipe a name the user is typing right now.
    const typing = document.activeElement;
    if (typing && chipsEl.contains(typing) && typing.classList.contains('cgpt-bm-chip-input')) return;

    const { bookmarks, collections } = libraryCache;
    chipsEl.innerHTML = '';

    const makeChip = (label, count, isActive, onClick, extraClass) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'cgpt-bm-chip' + (isActive ? ' is-active' : '') + (extraClass ? ' ' + extraClass : '');
      chip.setAttribute('aria-pressed', String(isActive));
      const text = document.createElement('span');
      text.className = 'cgpt-bm-chip-label';
      text.textContent = label;
      chip.appendChild(text);
      if (count !== null) {
        const num = document.createElement('span');
        num.className = 'cgpt-bm-chip-count';
        num.textContent = String(count);
        chip.appendChild(num);
      }
      chip.addEventListener('click', onClick);
      return chip;
    };

    chipsEl.appendChild(
      makeChip('All', bookmarks.length, activeCollectionId === null, () => selectCollection(null))
    );
    for (const col of collections) {
      chipsEl.appendChild(
        makeChip(col.name, col.bookmarkIds.length, activeCollectionId === col.id, () => selectCollection(col.id))
      );
    }
    chipsEl.appendChild(makeChip('+ New collection', null, false, startNewCollection, 'is-new'));
  }

  function selectCollection(id) {
    activeCollectionId = id;
    renderAllItems = false;
    delete deleteColBtnEl.dataset.armed;
    clearTimeout(deleteArmTimer);
    renderCollectionsBar();
    renderBookmarkItems();
  }

  /** Replaces `replaceEl` (or appends) with a small name field. */
  function showNameInput({ initial, placeholder, onSubmit, replaceEl }) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cgpt-bm-chip-input';
    input.maxLength = 40;
    input.placeholder = placeholder;
    input.value = initial || '';
    input.setAttribute('aria-label', placeholder);

    let finished = false;
    const finish = async (submit) => {
      if (finished) return;
      finished = true;
      const value = input.value;
      input.blur();
      if (submit && value.trim()) {
        try {
          await onSubmit(value);
        } catch (err) {
          showToast(errText(err), 'warning', 4500);
        }
      }
      renderCollectionsBar();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(false));

    if (replaceEl) replaceEl.replaceWith(input);
    else chipsEl.appendChild(input);
    input.focus();
    input.select();
  }

  function startNewCollection(e) {
    showNameInput({
      initial: '',
      placeholder: 'Collection name',
      replaceEl: e.currentTarget,
      onSubmit: async (name) => {
        const { collection } = await createCollection(name);
        activeCollectionId = collection.id;
        await refreshBookmarkList();
      }
    });
  }

  function startRenameActiveCollection() {
    const col = libraryCache.collections.find((c) => c.id === activeCollectionId);
    if (!col) return;
    const activeChip = chipsEl.querySelector('.cgpt-bm-chip.is-active');
    showNameInput({
      initial: col.name,
      placeholder: 'Collection name',
      replaceEl: activeChip,
      onSubmit: async (name) => {
        await renameCollection(col.id, name);
        await refreshBookmarkList();
        showToast('Collection renamed.', 'success');
      }
    });
  }

  /** Two clicks: the first arms the button (with a 4 s window), the second deletes the grouping. */
  async function deleteActiveCollection() {
    const col = libraryCache.collections.find((c) => c.id === activeCollectionId);
    if (!col) return;
    if (!deleteColBtnEl.dataset.armed) {
      deleteColBtnEl.dataset.armed = '1';
      deleteColBtnEl.textContent = 'Click again to confirm';
      clearTimeout(deleteArmTimer);
      deleteArmTimer = setTimeout(() => {
        delete deleteColBtnEl.dataset.armed;
        deleteColBtnEl.textContent = 'Delete collection';
      }, 4000);
      return;
    }
    clearTimeout(deleteArmTimer);
    delete deleteColBtnEl.dataset.armed;
    try {
      const kept = col.bookmarkIds.length;
      await deleteCollection(col.id);
      activeCollectionId = null;
      await refreshBookmarkList();
      showToast(`Collection “${col.name}” deleted. Its ${kept} bookmark${kept === 1 ? ' was' : 's were'} kept.`, 'info', 4500);
    } catch (err) {
      showToast('Could not delete the collection: ' + errText(err), 'warning');
    }
  }

  async function toggleGroupByChat() {
    groupByChat = !groupByChat;
    renderAllItems = false;
    renderBookmarkItems();
    try {
      await setSetting('ui', { grouped: groupByChat });
    } catch {
      // preference only
    }
  }

  // ---- floating pieces: add-to-collection popover and the "more" menu -------------------------

  function closeFloating() {
    if (floatingPopoverEl) {
      floatingPopoverEl.remove();
      floatingPopoverEl = null;
    }
    if (menuEl) {
      menuEl.hidden = true;
      const kebab = sidebarEl && sidebarEl.querySelector('[data-action="menu"]');
      if (kebab) kebab.setAttribute('aria-expanded', 'false');
    }
  }

  function openCollectionsPopover(triggerBtn, bm) {
    const alreadyOpenForThis = floatingPopoverEl && floatingPopoverEl.dataset.bookmarkId === bm.id;
    closeFloating();
    if (alreadyOpenForThis) return; // second click on the same button closes it

    const popover = document.createElement('div');
    popover.className = 'cgpt-bm-popover';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', 'Add to collection');
    popover.setAttribute('data-cgpt-bm-ui', 'true');
    popover.dataset.bookmarkId = bm.id;

    const title = document.createElement('div');
    title.className = 'cgpt-bm-popover-title';
    title.textContent = 'Add to collection';

    const list = document.createElement('div');
    list.className = 'cgpt-bm-popover-list';

    const newRow = document.createElement('div');
    newRow.className = 'cgpt-bm-popover-new';
    const newInput = document.createElement('input');
    newInput.type = 'text';
    newInput.className = 'cgpt-bm-chip-input';
    newInput.maxLength = 40;
    newInput.placeholder = 'New collection';
    newInput.setAttribute('aria-label', 'New collection name');
    const newBtn = document.createElement('button');
    newBtn.type = 'button';
    newBtn.className = 'cgpt-bm-btn cgpt-bm-btn-primary is-small';
    newBtn.textContent = 'Create';
    newRow.append(newInput, newBtn);

    popover.append(title, list, newRow);

    const isMember = (col) => col.bookmarkIds.includes(bm.id);

    const drawRows = () => {
      list.innerHTML = '';
      const cols = libraryCache.collections;
      if (cols.length === 0) {
        const hint = document.createElement('div');
        hint.className = 'cgpt-bm-popover-hint';
        hint.textContent = 'No collections yet. Create your first one below.';
        list.appendChild(hint);
        return;
      }
      for (const col of cols) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'cgpt-bm-popover-row';
        row.setAttribute('role', 'menuitemcheckbox');
        row.setAttribute('aria-checked', String(isMember(col)));
        const box = document.createElement('span');
        box.className = 'cgpt-bm-check';
        box.innerHTML = ICONS.check;
        const name = document.createElement('span');
        name.className = 'cgpt-bm-popover-name';
        name.textContent = col.name;
        row.append(box, name);

        row.addEventListener('click', async () => {
          const wasMember = isMember(col);
          try {
            if (wasMember) {
              await removeFromCollection(col.id, bm.id);
              col.bookmarkIds = col.bookmarkIds.filter((id) => id !== bm.id);
            } else {
              await addToCollection(col.id, bm.id);
              col.bookmarkIds = [...col.bookmarkIds, bm.id];
            }
            row.setAttribute('aria-checked', String(!wasMember));
            renderCollectionsBar();
            renderBookmarkItems();
          } catch (err) {
            showToast(errText(err), 'warning', 4500);
            await refreshBookmarkList();
            drawRows();
          }
        });
        list.appendChild(row);
      }
    };

    const createAndAdd = async () => {
      const name = newInput.value;
      if (!name.trim()) return;
      try {
        const { collection } = await createCollection(name);
        await addToCollection(collection.id, bm.id);
        newInput.value = '';
        await refreshBookmarkList();
        drawRows();
        showToast(`Added to “${collection.name}”.`, 'success', 2500);
      } catch (err) {
        showToast(errText(err), 'warning', 4500);
      }
    };
    newBtn.addEventListener('click', createAndAdd);
    newInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        createAndAdd();
      }
    });

    drawRows();
    sidebarEl.appendChild(popover);
    floatingPopoverEl = popover;

    // Position next to the button, kept inside the sidebar.
    const sidebarRect = sidebarEl.getBoundingClientRect();
    const btnRect = triggerBtn.getBoundingClientRect();
    const width = popover.offsetWidth || 240;
    let left = btnRect.right - sidebarRect.left - width;
    left = Math.max(8, Math.min(left, sidebarRect.width - width - 8));
    let top = btnRect.bottom - sidebarRect.top + 6;
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
    const height = popover.offsetHeight;
    if (top + height > sidebarRect.height - 8) {
      top = Math.max(8, btnRect.top - sidebarRect.top - height - 6);
      popover.style.top = `${top}px`;
    }
  }

  // ---- page check -----------------------------------------------------------------------------

  const Health = window.CGPTBookmarkerHealth;
  const HEALTH_LABEL = {
    healthy: 'Healthy',
    attention: 'Needs attention',
    broken: 'Problem detected',
    unknown: 'Not checked yet'
  };

  let healthState = null; // persisted summary (last healthy, problem first seen)
  let lastHealthResult = null; // details of the latest check run in this page session
  let healthRunning = false;
  let healthLastTryAt = 0;
  let healthCheckedChatKey = null;

  const formatDateTime = (ts) =>
    ts ? new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '–';

  function currentHealthStatus() {
    if (lastHealthResult && lastHealthResult.status !== 'unknown') return lastHealthResult.status;
    return (healthState && healthState.status) || 'unknown';
  }

  function updateHealthIndicators() {
    const status = currentHealthStatus();
    if (healthRowEl) {
      healthRowEl.querySelector('.cgpt-bm-health-dot').dataset.status = status;
      healthRowEl.querySelector('.cgpt-bm-health-text').textContent = `Page check: ${HEALTH_LABEL[status]}`;
      const when = (lastHealthResult && lastHealthResult.at) || (healthState && healthState.lastRunAt);
      healthRowEl.querySelector('.cgpt-bm-health-meta').textContent = when ? formatRelativeTime(when) : '';
    }
    if (toggleDotEl) {
      // The pill only shows a dot when something needs attention, so it stays quiet otherwise.
      const flagged = status === 'attention' || status === 'broken';
      toggleDotEl.hidden = !flagged;
      toggleDotEl.dataset.status = status;
    }
    if (panelEl && !panelEl.hidden) renderHealthPanel();
  }

  function healthDeps() {
    return {
      selectors: window.CGPTBookmarkerSelectors,
      engine: window.CGPTBookmarkerAnchorEngine,
      storage: window.CGPTBookmarkerStorage,
      probeScrollers
    };
  }

  function extensionVersion() {
    try {
      return chrome.runtime.getManifest().version;
    } catch {
      return '';
    }
  }

  /** Runs the check. Never throws and never blocks anything else. */
  async function runHealth(full) {
    if (!Health || healthRunning) return lastHealthResult;
    healthRunning = true;
    try {
      const result = await Health.runChecks(healthDeps(), { full });
      lastHealthResult = result;
      healthState = await Health.recordResult(window.CGPTBookmarkerStorage, result, extensionVersion());
    } catch (err) {
      console.warn('[ChatGPT Text Bookmarker] Page check failed:', err);
    } finally {
      healthRunning = false;
      updateHealthIndicators();
    }
    return lastHealthResult;
  }

  /**
   * Light check, once per chat, when the browser is idle and the page has settled. It is read-only
   * and does not scroll anything, so it cannot slow down or disturb bookmarking or jumping.
   */
  function scheduleLightHealthCheck(snap) {
    if (!Health || healthRunning || !snap.strong || snap.ids.size === 0) return;
    const key = snap.urlId || 'root';
    const now = Date.now();
    if (healthCheckedChatKey === key || now - healthLastTryAt < 8000) return;
    healthLastTryAt = now;

    const run = async () => {
      // Never compete with a bookmark jump or search: wait until it is over.
      if (isSearching || Date.now() - lastJumpStartedAt < 15000) {
        setTimeout(run, 3000);
        return;
      }
      const result = await runHealth(false);
      if (result && result.status !== 'unknown') healthCheckedChatKey = key;
    };
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 4000 });
    else setTimeout(run, 1500);
  }

  async function loadHealthState() {
    if (!Health) return;
    healthState = await Health.loadState(window.CGPTBookmarkerStorage);
    updateHealthIndicators();
  }

  function openHealthPanel() {
    closeFloating();
    panelEl.hidden = false;
    renderHealthPanel();
    const back = panelEl.querySelector('[data-panel="back"]');
    if (back) back.focus();
  }

  function closeHealthPanel() {
    panelEl.hidden = true;
    panelEl.innerHTML = '';
    healthRowEl.focus();
  }

  function renderHealthPanel() {
    const status = currentHealthStatus();
    const result = lastHealthResult;
    const state = healthState || {};

    panelEl.innerHTML = '';
    const header = document.createElement('div');
    header.className = 'cgpt-bm-panel-header';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'cgpt-bm-icon-btn';
    back.dataset.panel = 'back';
    back.setAttribute('aria-label', 'Back to bookmarks');
    back.innerHTML = ICONS.back;
    back.addEventListener('click', closeHealthPanel);
    const title = document.createElement('div');
    title.className = 'cgpt-bm-panel-title';
    title.textContent = 'Page check';
    header.append(back, title);

    const body = document.createElement('div');
    body.className = 'cgpt-bm-panel-body';

    const card = document.createElement('div');
    card.className = 'cgpt-bm-status-card';
    card.dataset.status = status;
    const dot = document.createElement('span');
    dot.className = 'cgpt-bm-health-dot';
    dot.dataset.status = status;
    const cardText = document.createElement('div');
    const cardTitle = document.createElement('div');
    cardTitle.className = 'cgpt-bm-status-title';
    cardTitle.textContent = HEALTH_LABEL[status];
    const cardDesc = document.createElement('div');
    cardDesc.className = 'cgpt-bm-status-desc';
    cardDesc.textContent = Health ? Health.HEADLINES[status] : '';
    cardText.append(cardTitle, cardDesc);
    card.append(dot, cardText);
    body.appendChild(card);

    const facts = document.createElement('dl');
    facts.className = 'cgpt-bm-facts';
    const addFact = (label, value) => {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      facts.append(dt, dd);
    };
    addFact('Last checked', result ? `${formatDateTime(result.at)} (${result.full ? 'full' : 'quick'} check)` : state.lastRunAt ? formatDateTime(state.lastRunAt) : 'Not yet');
    addFact('Last healthy', formatDateTime(state.lastHealthyAt));
    if (state.firstProblemAt) addFact('Problem first seen', formatDateTime(state.firstProblemAt));
    addFact('Extension version', extensionVersion() || '–');
    body.appendChild(facts);

    const checks = result ? result.checks : null;
    if (checks && checks.length > 0) {
      const list = document.createElement('ul');
      list.className = 'cgpt-bm-checks';
      for (const c of checks) {
        const li = document.createElement('li');
        li.className = 'cgpt-bm-check-row';
        li.dataset.status = c.status;
        const mark = document.createElement('span');
        mark.className = 'cgpt-bm-check-mark';
        mark.textContent = { ok: '✓', warn: '!', fail: '✕', skip: '–' }[c.status] || '–';
        const text = document.createElement('div');
        const label = document.createElement('div');
        label.className = 'cgpt-bm-check-label';
        label.textContent = c.label;
        const detail = document.createElement('div');
        detail.className = 'cgpt-bm-check-detail';
        detail.textContent = c.detail;
        text.append(label, detail);
        li.append(mark, text);
        list.appendChild(li);
      }
      body.appendChild(list);

      const details = document.createElement('details');
      details.className = 'cgpt-bm-details';
      const summary = document.createElement('summary');
      summary.textContent = 'Page markers seen right now';
      details.appendChild(summary);
      const table = document.createElement('div');
      table.className = 'cgpt-bm-markers';
      for (const s of result.signals) {
        const row = document.createElement('div');
        row.className = 'cgpt-bm-marker-row' + (s.count > 0 ? '' : ' is-zero');
        const sel = document.createElement('code');
        sel.textContent = s.selector;
        const n = document.createElement('span');
        n.textContent = s.count < 0 ? 'invalid' : String(s.count);
        row.append(sel, n);
        table.appendChild(row);
      }
      details.appendChild(table);
      body.appendChild(details);
    } else if (state.problems && state.problems.length > 0) {
      const note = document.createElement('div');
      note.className = 'cgpt-bm-panel-note';
      note.textContent = 'Last problem found: ' + state.problems.map((p) => p.detail).join(' ');
      body.appendChild(note);
    } else {
      const note = document.createElement('div');
      note.className = 'cgpt-bm-panel-note';
      note.textContent = 'No check has run in this tab yet. Open a chat with responses, or run a full check.';
      body.appendChild(note);
    }

    const actions = document.createElement('div');
    actions.className = 'cgpt-bm-panel-actions';
    const runBtn = document.createElement('button');
    runBtn.type = 'button';
    runBtn.className = 'cgpt-bm-btn cgpt-bm-btn-primary';
    runBtn.textContent = healthRunning ? 'Checking…' : 'Run full check';
    runBtn.disabled = healthRunning;
    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true;
      runBtn.textContent = 'Checking…';
      await runHealth(true);
    });
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'cgpt-bm-btn';
    copyBtn.textContent = 'Copy report';
    copyBtn.addEventListener('click', handleCopyHealthReport);
    actions.append(runBtn, copyBtn);

    panelEl.append(header, body, actions);
  }

  async function handleCopyHealthReport() {
    if (!lastHealthResult) await runHealth(true);
    const report = {
      report: 'Pinpoint page-check report (contains no chat text)',
      extensionVersion: extensionVersion(),
      collectedAt: new Date().toISOString(),
      browser: navigator.userAgent,
      health: lastHealthResult,
      history: healthState,
      diagnostics: buildDiagnostics()
    };
    await copyToClipboard(JSON.stringify(report, null, 2));
    showToast('Report copied (contains no chat text).', 'success');
  }

  function formatRelativeTime(timestamp) {
    if (!timestamp) return 'Just now';
    const diffSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    if (diffSec < 45) return 'Just now';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    return `${diffDay}d ago`;
  }

  // ---------------------------------------------------------------------------
  // Bookmark navigation (virtualization-aware)
  //
  // In very long conversations ChatGPT unmounts turns that are far from the viewport, so the
  // target message simply is not in the DOM. We therefore:
  //   1. try to resolve the passage in what is currently mounted,
  //   2. otherwise sweep-scroll the conversation (starting near where the bookmark was made)
  //      so the virtualizer mounts messages, re-trying after every step,
  //   3. only report "edited/regenerated" when the *right* message was mounted and really
  //      lacks the passage -- never just because it was not rendered.
  // ---------------------------------------------------------------------------

  let navToken = 0; // bumped to cancel an in-flight search
  let isSearching = false;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

  async function waitForRender() {
    await nextFrame();
    await nextFrame();
    await sleep(80);
  }

  function isResolved(found) {
    return Boolean(
      found &&
        found.resolution &&
        found.resolution.status === 'resolved' &&
        found.resolution.range
    );
  }

  // ---------------------------------------------------------------------------
  // Diagnostics (opt-in: copied by the "Debug info" button; NEVER contains chat text)
  // ---------------------------------------------------------------------------

  const debugState = { jump: null, history: [] };
  let lastJumpStartedAt = 0; // lets background work (the page check) stay out of the way of a jump

  function dbgStart(bookmark) {
    lastJumpStartedAt = Date.now();
    if (debugState.jump) {
      debugState.history.push(debugState.jump);
      if (debugState.history.length > 4) debugState.history.shift();
    }
    debugState.jump = {
      startedAt: new Date().toISOString(),
      bookmark: {
        messageIdLength: bookmark.messageId ? bookmark.messageId.length : 0,
        hasTurnKey: Boolean(bookmark.turnKey),
        hasUnitKey: Boolean(bookmark.searchUnitKey),
        hintPx: typeof bookmark.scrollOffsetPx === 'number' ? Math.round(bookmark.scrollOffsetPx) : null,
        passageLength: (bookmark.selectedText || '').length,
        linkedChats: bookmark.conversationIds ? bookmark.conversationIds.length : 0
      },
      events: []
    };
  }

  function dbg(type, data) {
    const jump = debugState.jump;
    if (!jump || jump.events.length >= 400) return;
    jump.events.push({ t: Math.round(performance.now()), type, ...(data || {}) });
  }

  function describeEl(el) {
    if (!el) return null;
    let overflowY = '';
    try {
      overflowY = window.getComputedStyle(el).overflowY;
    } catch {
      // ignore
    }
    return {
      tag: el.tagName ? el.tagName.toLowerCase() : '?',
      id: el.id || '',
      className: String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '').slice(0, 80),
      dataAttributes: Array.from(el.attributes || [])
        .filter((a) => a.name.startsWith('data-'))
        .map((a) => a.name)
        .slice(0, 8),
      overflowY,
      scrollTop: Math.round(el.scrollTop),
      scrollHeight: Math.round(el.scrollHeight),
      clientHeight: Math.round(el.clientHeight)
    };
  }

  // ---------------------------------------------------------------------------
  // Which element REALLY scrolls the conversation?
  // A selector can match an element that is not the one that scrolls (or stops being it when the
  // layout changes). So we test: nudge each candidate and see whether a message actually moves.
  // ---------------------------------------------------------------------------

  function probeScrollers(refEl) {
    const candidates = [];
    const add = (el) => {
      if (el && !candidates.includes(el)) candidates.push(el);
    };

    if (refEl) {
      add(findScrollContainer(refEl));
      for (let p = refEl.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
        let overflowY = '';
        try {
          overflowY = window.getComputedStyle(p).overflowY;
        } catch {
          // ignore
        }
        if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') add(p);
      }
    }
    document
      .querySelectorAll('[data-mcp-app-scroll-host], [data-app-action-timeline-scroll]')
      .forEach(add);
    add(document.scrollingElement);

    const results = [];
    for (const el of candidates) {
      const maxTop = el.scrollHeight - el.clientHeight;
      const info = { el, scrollable: maxTop > 2, moved: false };
      if (info.scrollable && refEl && refEl.isConnected) {
        const old = el.scrollTop;
        // One measurement can be fooled (layout shifting while heights are measured), so a
        // candidate gets a second, larger nudge before it is judged "does not move the messages".
        for (const size of [80, 160]) {
          const delta = old + size <= maxTop ? size : -size;
          const before = refEl.getBoundingClientRect().top;
          el.scrollTo({ top: old + delta, behavior: 'instant' });
          const after = refEl.getBoundingClientRect().top;
          el.scrollTo({ top: old, behavior: 'instant' });
          if (Math.abs(after - before) > 20) {
            info.moved = true;
            break;
          }
        }
      }
      results.push(info);
    }
    return results;
  }

  let verifiedScroller = null; // last scroller that was PROVEN to move the messages

  function findWorkingScroller(refEl) {
    const ref = refEl || getRenderedAssistantMessages()[0] || null;

    if (
      verifiedScroller &&
      verifiedScroller.isConnected &&
      (!ref || verifiedScroller.contains(ref)) &&
      verifiedScroller.scrollHeight > verifiedScroller.clientHeight + 2
    ) {
      return verifiedScroller; // proven earlier: no need to nudge the page again
    }

    const probes = probeScrollers(ref);
    const moved = probes.find((p) => p.moved);
    if (moved) {
      verifiedScroller = moved.el;
      return moved.el;
    }

    // Nothing proved itself. Prefer an element that can genuinely scroll (and furthest), rather
    // than blindly trusting the first selector match, which may be a wrapper that never scrolls.
    const scrollable = probes
      .filter((p) => p.scrollable)
      .sort((a, b) => b.el.scrollHeight - b.el.clientHeight - (a.el.scrollHeight - a.el.clientHeight));
    return scrollable.length > 0 ? scrollable[0].el : findScrollContainer(ref);
  }

  // ---------------------------------------------------------------------------
  // Bookmark resolution
  // ---------------------------------------------------------------------------

  function compactHead(bookmark) {
    return (bookmark.normalizedText || bookmark.selectedText || '').replace(/\s+/g, '').slice(0, 24);
  }

  /**
   * Is this element a real message of the conversation being read (as opposed to a side panel,
   * outline, preview or other copy that merely carries the same id)? Only a real message can prove
   * that a response was edited: an always-present duplicate that lacks the passage proves nothing.
   */
  function isConversationMessage(el) {
    const isMessage = getRenderedAssistantMessages().some(
      (m) => m === el || m.contains(el) || el.contains(m)
    );
    if (!isMessage) return false;
    const hostSelector = '[data-mcp-app-scroll-host], [data-app-action-timeline-scroll]';
    return !document.querySelector(hostSelector) || Boolean(el.closest(hostSelector));
  }

  /**
   * Resolves a bookmark against the currently MOUNTED messages only. Decides by TEXT, using the
   * ids only as a hint:
   *   - every element that carries one of the bookmark's ids is examined (not just the first),
   *   - plus every other mounted assistant message that contains the passage's opening text.
   * Returns { assistantEl, resolution }; assistantEl is null when nothing relevant is mounted.
   */
  function locateAndResolveBookmark(bookmark) {
    const evaluated = [];
    const seen = new Set();
    const evaluate = (el, viaId) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      evaluated.push({ el, viaId, res: resolveBookmarkRange(bookmark, el) });
    };

    const idCandidates = locateBookmarkCandidates(bookmark);
    for (const el of idCandidates) evaluate(el, true);

    const head = compactHead(bookmark);
    let pool = getRenderedAssistantMessages();
    if (pool.length === 0) pool = getAllAssistantMessages();
    for (const el of pool) {
      if (seen.has(el)) continue;
      if (head && !(el.textContent || '').replace(/\s+/g, '').includes(head)) continue;
      evaluate(el, false);
    }

    const resolved = evaluated.filter((e) => e.res.status === 'resolved' && e.res.range);
    // Text found in an element that carries the bookmark's id is accepted as is; in any other
    // element it must be the same response or have strongly matching surrounding text.
    const trusted = resolved.filter(
      (e) => e.viaId || !e.res.fingerprintChanged || (e.res.confidence || 0) >= 0.6
    );
    const info = {
      idCandidates: idCandidates.length,
      evaluated: evaluated.length,
      statuses: evaluated.slice(0, 6).map((e) => (e.viaId ? 'id:' : 'txt:') + e.res.status)
    };

    if (trusted.length > 0) {
      const weight = (e) => (e.res.confidence || 0) + (e.viaId ? 0.5 : 0);
      trusted.sort((a, b) => weight(b) - weight(a));
      return { assistantEl: trusted[0].el, resolution: trusted[0].res, info };
    }

    // The right message is mounted (found by id) but its text genuinely lacks the passage.
    const mismatch = evaluated.find(
      (e) => e.viaId && e.res.status === 'changed' && isConversationMessage(e.el)
    );
    if (mismatch) return { assistantEl: mismatch.el, resolution: mismatch.res, info };

    return {
      assistantEl: null,
      resolution: {
        status: 'not_found',
        reason: 'The original response is not currently rendered in this conversation.'
      },
      info
    };
  }

  /**
   * One resolution attempt. Returns:
   *   { found }    -> passage located
   *   { changed }  -> the correct message is mounted, fully settled, and genuinely lacks the passage
   *   null         -> target not mounted / not rendered yet (caller should scroll and retry)
   */
  async function tryResolveSettled(bookmark) {
    let found = locateAndResolveBookmark(bookmark);
    if (isResolved(found)) return { found };

    if (found.assistantEl && found.resolution.status === 'changed') {
      // Mounted but the text did not match. It may still be hydrating (markdown, code blocks,
      // formulas), so re-check a few times before declaring it changed.
      for (let i = 0; i < 3; i++) {
        await sleep(450);
        found = locateAndResolveBookmark(bookmark);
        if (isResolved(found)) return { found };
        if (!found.assistantEl || found.resolution.status !== 'changed') return null;
      }
      return { changed: found };
    }
    return null;
  }

  /**
   * Stable identity for a mounted message (used to check that two scroll positions "see"
   * overlapping parts of the conversation, i.e. that we did not jump over unmounted content).
   */
  function messageKey(el) {
    const idEl = el.closest('[data-chatgpt-search-message-ids]') ||
      el.querySelector('[data-chatgpt-search-message-ids]');
    if (idEl) return idEl.getAttribute('data-chatgpt-search-message-ids');
    const turn = el.closest('[data-turn-key]') || el.querySelector('[data-turn-key]');
    if (turn) return turn.getAttribute('data-turn-key');
    return 'txt:' + (el.textContent || '').trim().slice(0, 80);
  }

  /**
   * Snapshot of what is rendered right now: the set of message keys and the height of the
   * contiguous block they occupy (virtualizers keep a contiguous window mounted).
   */
  function snapshotMounted(scroller) {
    const keys = new Set();
    let top = Infinity;
    let bottom = -Infinity;
    for (const el of getRenderedAssistantMessages()) {
      keys.add(messageKey(el));
      const r = el.getBoundingClientRect();
      if (r.height > 0) {
        top = Math.min(top, viewportToContentY(scroller, r.top));
        bottom = Math.max(bottom, viewportToContentY(scroller, r.bottom));
      }
    }
    return { keys, span: bottom > top ? bottom - top : 0 };
  }

  function setsIntersect(a, b) {
    for (const k of a) if (b.has(k)) return true;
    return false;
  }

  /**
   * True when the visible part of the scroller is FILLED with rendered messages from top to
   * bottom. "Something is rendered" is not enough: right after a long jump, a few messages left
   * over from the previous position can still overlap the top of the new viewport while the
   * messages for the rest of it have not been mounted yet. Blank stretches inside the viewport
   * therefore mean "still loading" (small gaps between turns and blank space above the first /
   * below the last message of the whole conversation are tolerated).
   */
  function viewportHasContent(scroller) {
    let bandTop = 0;
    let bandBottom = window.innerHeight;
    if (!isRootScroller(scroller)) {
      const sr = scroller.getBoundingClientRect();
      bandTop = sr.top;
      bandBottom = sr.bottom;
    }

    const atTop = scroller.scrollTop <= 1;
    const atBottom = scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 1;
    const GAP = 120; // normal spacing between turns
    const EDGE = 260; // padding above the first / below the last message of the chat

    const intervals = [];
    for (const el of getRenderedTurnElements()) {
      const r = el.getBoundingClientRect();
      if (r.height <= 0) continue;
      const a = Math.max(bandTop, r.top);
      const b = Math.min(bandBottom, r.bottom);
      if (b > a) intervals.push([a, b]);
    }
    if (intervals.length === 0) return false;

    intervals.sort((x, y) => x[0] - y[0]);
    let cursor = bandTop;
    for (const [a, b] of intervals) {
      const allowed = cursor === bandTop ? (atTop ? EDGE : GAP) : GAP;
      if (a - cursor > allowed) return false;
      cursor = Math.max(cursor, b);
    }
    return bandBottom - cursor <= (atBottom ? EDGE : GAP);
  }

  /**
   * Resolves once the conversation has SETTLED at the current scroll position:
   *   - the viewport shows rendered content (not blank / still loading), AND
   *   - there were no DOM mutations (ignoring our own UI) and no scrollHeight change for quietMs,
   * but never sooner than minMs or later than maxMs.
   * A fixed sleep was too short whenever ChatGPT mounted messages late; "quiet" alone is not
   * enough either, because a page that has not started rendering yet is also quiet.
   */
  function waitForSettle(scroller, opts = {}) {
    const { minMs = 120, quietMs = 150, maxMs = 2800 } = opts;
    return new Promise((resolve) => {
      const start = performance.now();
      let lastChange = start;
      let lastHeight = scroller.scrollHeight;

      const observer = new MutationObserver((records) => {
        for (const rec of records) {
          const el = rec.target.nodeType === Node.ELEMENT_NODE ? rec.target : rec.target.parentElement;
          if (el && el.closest && el.closest('[data-cgpt-bm-ui="true"]')) continue;
          lastChange = performance.now();
          return;
        }
      });
      observer.observe(isRootScroller(scroller) ? document.body : scroller, {
        childList: true,
        subtree: true,
        characterData: true
      });

      const tick = () => {
        const now = performance.now();
        const h = scroller.scrollHeight;
        if (h !== lastHeight) {
          lastHeight = h;
          lastChange = now;
        }
        const elapsed = now - start;
        const quiet = now - lastChange >= quietMs;
        const ready = viewportHasContent(scroller);
        if (elapsed >= minMs && quiet && ready) {
          observer.disconnect();
          resolve({ timedOut: false, ready: true });
          return;
        }
        if (elapsed >= maxMs) {
          observer.disconnect();
          resolve({ timedOut: true, ready });
          return;
        }
        setTimeout(tick, 40);
      };
      setTimeout(tick, 40);
    });
  }

  /**
   * Waits (briefly) until the conversation has actually rendered and stopped changing size.
   * Right after a page load ChatGPT is still mounting messages and measuring heights; sweeping
   * (or trusting hint positions) in that window is what made the first attempt unreliable.
   */
  async function waitForConversationReady(token, maxMs = 8000) {
    const start = performance.now();
    let lastHeight = -1;
    let stableSince = start;
    while (performance.now() - start < maxMs) {
      if (token !== navToken) return;
      const sample = getRenderedTurnElements()[0] || null;
      const container = sample ? findScrollContainer(sample) : null;
      const height = container ? container.scrollHeight : -1;
      const now = performance.now();
      if (height !== lastHeight) {
        lastHeight = height;
        stableSince = now;
      }
      if (sample && now - stableSince >= 500) return;
      await sleep(120);
    }
  }

  /**
   * One search round over the whole conversation.
   *   careful = false : fast (large steps, short waits)
   *   careful = true  : second look (small steps, longer waits, so messages that mount or fill in
   *                     late cannot be scrolled past)
   *
   * Order: 1) saved-position hints (proportion first -- it survives ChatGPT re-estimating heights;
   * the raw pixel value does not), 2) a window around each hint, 3) one pass from the very top to
   * the bottom, always scrolling DOWN so the page loads messages in reading order.
   *
   * Nothing is ever skipped by pixel range: on a virtualized list heights change as messages are
   * measured, so a pixel range scanned earlier no longer refers to the same messages.
   */
  async function sweepRound(bookmark, token, careful, roundNo) {
    const refEl = getRenderedAssistantMessages()[0] || getRenderedTurnElements()[0] || null;
    const scroller = findWorkingScroller(refEl);
    if (!scroller) {
      dbg('no-scroller');
      return { notFound: true };
    }
    dbg('round-start', { round: roundNo, careful, scroller: describeEl(scroller) });

    const prefix = careful ? 'Second look: ' : '';
    const originalTop = scroller.scrollTop;
    const startHeight = scroller.scrollHeight;
    const vh = scroller.clientHeight;
    // A viewport is always fully mounted, so tiles of ~0.9 viewport cover everything with a small overlap.
    const minStep = Math.max(240, Math.floor(vh * 0.9));
    const maxStepPx = careful ? vh * 2 : vh * 6;
    const maxTop = () => Math.max(0, scroller.scrollHeight - vh);
    const clamp = (y) => Math.max(0, Math.min(maxTop(), y));

    const settleFor = (y) => {
      if (y <= 1) return careful ? { minMs: 500, quietMs: 600, maxMs: 5000 } : { minMs: 300, quietMs: 400, maxMs: 3500 }; // top: allow older-message loading
      return careful ? { minMs: 250, quietMs: 300, maxMs: 4500 } : undefined;
    };

    const startedAt = performance.now();
    const MAX_MS = 300000; // generous: the user can cancel at any time and sees live progress
    const MAX_STEPS = 2000;
    let totalSteps = 0;
    let suspects = 0;

    function outOfBudget() {
      return performance.now() - startedAt > MAX_MS || ++totalSteps > MAX_STEPS;
    }

    /** Scroll to y, wait for the page to settle, then try to resolve the bookmark. */
    async function visitAt(y) {
      const visitStart = performance.now();

      scroller.scrollTo({ top: y, behavior: 'instant' });
      const settle = await waitForSettle(scroller, settleFor(y));
      if (token !== navToken) return { cancelled: true };

      let actual = scroller.scrollTop;
      const reachable = y <= maxTop() - 8 && y >= 0;
      if (reachable && Math.abs(actual - y) > 8) {
        // The page did not go where we asked (or snapped back). Try once more another way.
        dbg('scroll-refused', { wanted: Math.round(y), actual: Math.round(actual) });
        scroller.scrollTop = y;
        await waitForSettle(scroller);
        if (token !== navToken) return { cancelled: true };
        actual = scroller.scrollTop;
      }

      const outcome = await tryResolveSettled(bookmark);
      if (token !== navToken) return { cancelled: true };

      const snap = snapshotMounted(scroller);
      if (settle && (settle.timedOut || !settle.ready)) suspects++;
      dbg('visit', {
        wanted: Math.round(y),
        actual: Math.round(actual),
        mounted: snap.keys.size,
        span: Math.round(snap.span),
        height: Math.round(scroller.scrollHeight),
        ms: Math.round(performance.now() - visitStart),
        slow: settle && settle.timedOut ? 1 : 0,
        result: outcome ? (outcome.found ? 'found' : 'changed') : 'miss'
      });

      if (outcome && outcome.found) return { found: outcome.found };
      if (outcome && outcome.changed) {
        try {
          outcome.changed.assistantEl.scrollIntoView({ block: 'center', behavior: 'instant' });
        } catch {
          // Cosmetic only
        }
        return { changed: outcome.changed.resolution.reason };
      }
      return { snap, actual };
    }

    /** One monotone downward pass over [startY, endY]. */
    async function pass(startY, endY, label) {
      let y = clamp(startY);
      let prevKeys = null;
      let prevY = y;
      let lastActual = null;
      let jump = minStep;
      let ceiling = maxStepPx; // largest jump we still trust; lowered whenever a jump leaves a gap
      let goodStreak = 0;
      let stalls = 0;
      let atEnd = false;
      let retreating = false;

      while (!atEnd) {
        if (outOfBudget()) return { exhausted: true, budget: true };

        const limit = Math.min(endY, maxTop());
        if (y >= limit) {
          y = limit;
          atEnd = true;
        }

        const res = await visitAt(y);
        if (res.cancelled || res.found || res.changed) return res;

        const pct = limit > 0 ? Math.min(99, Math.round((y / limit) * 100)) : 99;
        showToast(`${prefix}${label} ${pct}%`, 'info', 0);

        const snap = res.snap;

        // A page that will not move forward (pinned to the bottom, wrong element, locked) would
        // otherwise make us loop until the budget runs out.
        if (!retreating) {
          if (lastActual !== null && res.actual - lastActual < 4 && y - lastActual >= 8) stalls++;
          else stalls = 0;
          if (stalls >= 6) {
            dbg('stuck', { at: Math.round(res.actual) });
            return { exhausted: true, stuck: true };
          }
        }
        retreating = false;

        const overlaps = prevKeys === null || (snap.keys.size > 0 && setsIntersect(prevKeys, snap.keys));
        if (!overlaps && jump > minStep) {
          // Possible gap: we jumped past content that never got mounted. Back up, jump less,
          // and remember that jumps this big are not safe here (no endless grow/fail cycle).
          ceiling = Math.max(minStep, Math.floor(jump / 2));
          jump = ceiling;
          goodStreak = 0;
          y = prevY + jump;
          atEnd = false;
          retreating = true;
          continue;
        }

        prevKeys = snap.keys;
        prevY = res.actual; // build on where the page REALLY is
        lastActual = res.actual;
        if (++goodStreak >= 10) {
          // Conditions may have improved (e.g. page finished loading): cautiously allow bigger jumps.
          ceiling = Math.min(maxStepPx, Math.floor(ceiling * 1.5));
          goodStreak = 0;
        }
        const spanStep = Math.floor(snap.span * 0.8);
        jump = Math.max(minStep, Math.min(ceiling, spanStep, jump * 2));
        y = res.actual + jump;
      }
      return { exhausted: true };
    }

    // Phase 1: saved-position hints. Proportion first (robust to re-estimated heights), then pixels.
    const hints = [];
    const addHint = (y) => {
      const c = clamp(y);
      if (!hints.some((h) => Math.abs(h - c) < vh)) hints.push(c);
    };
    if (typeof bookmark.scrollRatio === 'number') {
      addHint(bookmark.scrollRatio * scroller.scrollHeight - vh / 2);
    }
    if (typeof bookmark.scrollOffsetPx === 'number') {
      addHint(bookmark.scrollOffsetPx - vh / 2);
    }
    dbg('hints', { count: hints.length, ratio: bookmark.scrollRatio, at: hints.map(Math.round) });

    for (const h of hints) {
      showToast(`${prefix}Looking near where it was bookmarked…`, 'info', 0);
      const res = await visitAt(h);
      if (res.cancelled || res.found || res.changed) return res;
    }

    const windowPx = Math.max(vh * 6, scroller.scrollHeight * 0.04);
    for (const h of hints) {
      const res = await pass(clamp(h - windowPx), clamp(h + windowPx), 'Scanning near the bookmarked position…');
      if (res.cancelled || res.found || res.changed) return res;
      if (res.stuck) {
        scroller.scrollTo({ top: originalTop, behavior: 'instant' });
        return { notFound: true, stuck: true };
      }
    }

    // Phase 2: the whole conversation, top -> bottom
    const res = await pass(0, Infinity, 'Searching the whole conversation…');
    if (res.cancelled || res.found || res.changed) return res;

    const drift = startHeight > 0 ? Math.abs(scroller.scrollHeight - startHeight) / startHeight : 0;
    dbg('round-end', { round: roundNo, stuck: Boolean(res.stuck), budget: Boolean(res.budget), steps: totalSteps, suspects, drift: Math.round(drift * 100) / 100 });
    scroller.scrollTo({ top: originalTop, behavior: 'instant' });
    return { notFound: true, stuck: Boolean(res.stuck), suspects, drift };
  }

  /**
   * Finds a bookmarked passage in a virtualized conversation. If the first (fast) round does not
   * find it, a second, careful round runs automatically -- the same thing that used to require
   * clicking the bookmark again, because on a second attempt ChatGPT has already measured the
   * messages and mounts them in time.
   */
  async function sweepForBookmark(bookmark, token) {
    await waitForConversationReady(token);
    if (token !== navToken) return { cancelled: true };

    let result = await sweepRound(bookmark, token, false, 1);
    if (result.notFound && !result.stuck && token === navToken) {
      dbg('retry', { suspects: result.suspects, drift: result.drift });
      showToast('Not found yet - taking a closer look…', 'info', 0);
      await sleep(500);
      if (token !== navToken) return { cancelled: true };
      result = await sweepRound(bookmark, token, true, 2);
    }
    return result;
  }

  /**
   * Full jump flow: resolve now, else sweep the conversation, then scroll + highlight.
   */
  async function runBookmarkJump(bookmark) {
    const token = ++navToken;
    dbgStart(bookmark);

    let outcome = await tryResolveSettled(bookmark);

    if (!outcome) {
      isSearching = true;
      showToast('Searching this long conversation for the passage…', 'info', 0);
      try {
        outcome = await sweepForBookmark(bookmark, token);
      } finally {
        isSearching = false;
      }
      if (token !== navToken || outcome.cancelled) {
        dbg('end', { outcome: 'cancelled' });
        hideToast();
        return;
      }
    }

    dbg('end', {
      outcome: outcome.found ? 'found' : outcome.changed ? 'edited' : outcome.stuck ? 'stuck' : 'not-found'
    });

    if (outcome.changed) {
      const reason = outcome.changed.resolution
        ? outcome.changed.resolution.reason
        : outcome.changed;
      showToast(reason, 'warning');
      return;
    }

    if (outcome.notFound && outcome.stuck) {
      showToast(
        'The conversation would not scroll, so the passage could not be searched for. Reload the page and try again (the sidebar "Debug info" button copies details if it keeps happening).',
        'warning',
        8000
      );
      return;
    }

    if (outcome.notFound) {
      showToast(
        'Could not find this passage after two passes through the whole conversation. The response may have been regenerated or deleted. If you think it is still there, wait for the chat to finish loading and try again.',
        'warning',
        8000
      );
      return;
    }

    hideToast();
    const { assistantEl, resolution } = outcome.found;

    scrollRangeToViewportCenter(resolution.range, assistantEl);
    renderTemporaryHighlight(resolution.range, () => {
      const again = locateAndResolveBookmark(bookmark);
      return isResolved(again) ? again.resolution.range : null;
    });

    if (resolution.fingerprintChanged) {
      showToast('Located passage (note: response was modified since bookmarking).', 'info');
    }

    // Virtualized lists measure neighbouring messages while/after we scroll, which pushes the
    // target off-center (and can push it out of view). Keep correcting until it stays put.
    for (let attempt = 0; attempt < 5; attempt++) {
      await sleep(attempt === 0 ? 850 : 550);
      if (token !== navToken) return;
      const check = await tryResolveSettled(bookmark);
      let again = check && check.found ? check.found : null;
      if (!again) {
        dbg('lost-after-center', { attempt });
        again = await relocateNearby(bookmark, token);
        if (!again) break;
      }
      const moved = scrollRangeToViewportCenter(again.resolution.range, again.assistantEl, {
        onlyIfOff: true,
        instant: attempt > 0
      });
      dbg('recenter', { attempt, moved });
      if (!moved) break;
    }
  }

  /**
   * The passage was found, but while we centered it ChatGPT measured neighbouring messages and
   * pushed it out of the mounted window. Look a little above and below the current position
   * (nearest first) until it is mounted again.
   */
  async function relocateNearby(bookmark, token) {
    const scroller = findWorkingScroller(null);
    if (!scroller) return null;
    const vh = scroller.clientHeight;
    const base = scroller.scrollTop;
    for (const mult of [0.7, -0.7, 1.4, -1.4, 2.1, -2.1, 3, -3]) {
      if (token !== navToken) return null;
      const y = Math.max(0, Math.min(scroller.scrollHeight - vh, base + mult * vh));
      scroller.scrollTo({ top: y, behavior: 'instant' });
      await waitForSettle(scroller);
      // Patient check: text may still be filling in after the message mounts.
      const outcome = await tryResolveSettled(bookmark);
      if (outcome && outcome.found) return outcome.found;
    }
    scroller.scrollTo({ top: base, behavior: 'instant' });
    return null;
  }

  async function navigateToBookmark(bookmark) {
    if (belongsToCurrentChat(bookmark)) {
      await runBookmarkJump(bookmark);
      return;
    }

    const chatId = bookmark.conversationId || bookmark.conversationIds[0] || null;
    if (!chatId) {
      showToast(
        'This bookmark is not linked to a saved chat yet. Open the chat it came from once and it will attach itself - or use "Move here" inside the right chat.',
        'warning',
        7000
      );
      return;
    }

    const targetPath =
      bookmark.conversationPath && bookmark.conversationPath.includes('/c/' + chatId)
        ? bookmark.conversationPath
        : `/c/${chatId}`;

    await setPendingJump(bookmark.id);
    window.location.href = `https://chatgpt.com${targetPath}`;
  }

  /** Returns true if it scrolled, false if the passage was already (close enough to) centered. */
  function scrollRangeToViewportCenter(range, assistantEl, options = {}) {
    const { onlyIfOff = false, instant = false } = options;
    const behavior = instant ? 'instant' : 'smooth';
    const scrollContainer = findWorkingScroller(assistantEl);
    const rect = range.getBoundingClientRect();

    if (
      scrollContainer &&
      scrollContainer !== document.documentElement &&
      scrollContainer !== document.body &&
      scrollContainer !== document.scrollingElement
    ) {
      const containerRect = scrollContainer.getBoundingClientRect();
      const offCenter =
        rect.top + rect.height / 2 - (containerRect.top + containerRect.height / 2);
      if (onlyIfOff && Math.abs(offCenter) < 80) return false;

      const rangeCenterInContainer =
        rect.top - containerRect.top + scrollContainer.scrollTop + rect.height / 2;
      const targetScrollTop = Math.max(
        0,
        rangeCenterInContainer - containerRect.height / 2
      );

      scrollContainer.scrollTo({
        top: targetScrollTop,
        behavior
      });
    } else {
      const offCenter = rect.top + rect.height / 2 - window.innerHeight / 2;
      if (onlyIfOff && Math.abs(offCenter) < 80) return false;

      const absoluteTop = window.scrollY + rect.top + rect.height / 2;
      const targetTop = Math.max(0, absoluteTop - window.innerHeight / 2);
      window.scrollTo({
        top: targetTop,
        behavior
      });
    }
    return true;
  }

  /**
   * @param {Range} initialRange
   * @param {() => (Range|null)} [reresolve] Optional: called when the range loses its layout
   *   (React re-rendered / virtualizer remounted the nodes) to obtain a fresh Range.
   */
  function renderTemporaryHighlight(initialRange, reresolve) {
    if (!highlightLayerEl) return;

    if (highlightCleanupTimer) clearTimeout(highlightCleanupTimer);
    if (highlightRafId) cancelAnimationFrame(highlightRafId);
    highlightLayerEl.innerHTML = '';

    let range = initialRange;
    let lastReresolveAt = 0;
    const startTime = performance.now();
    const DURATION_MS = 3000;

    function updateBoxes(now) {
      const elapsed = now - startTime;
      if (elapsed >= DURATION_MS) {
        highlightLayerEl.innerHTML = '';
        highlightRafId = null;
        return;
      }

      let clientRects = Array.from(range.getClientRects()).filter(
        (r) => r.width > 1 && r.height > 1
      );

      if (clientRects.length === 0 && reresolve && now - lastReresolveAt > 250) {
        lastReresolveAt = now;
        try {
          const fresh = reresolve();
          if (fresh) {
            range = fresh;
            clientRects = Array.from(range.getClientRects()).filter(
              (r) => r.width > 1 && r.height > 1
            );
          }
        } catch {
          // Keep animating; try again on the next interval
        }
      }

      let opacity = 1;
      if (elapsed > 2100) {
        opacity = Math.max(0, 1 - (elapsed - 2100) / 900);
      }

      highlightLayerEl.innerHTML = '';
      for (const r of clientRects) {
        if (r.bottom < 0 || r.top > window.innerHeight) continue;

        const box = document.createElement('div');
        box.className = 'cgpt-bm-highlight-rect';
        box.style.transform = `translate3d(${Math.round(r.left - 2)}px, ${Math.round(r.top - 1)}px, 0)`;
        box.style.width = `${Math.round(r.width + 4)}px`;
        box.style.height = `${Math.round(r.height + 2)}px`;
        box.style.opacity = opacity.toFixed(3);
        highlightLayerEl.appendChild(box);
      }

      highlightRafId = requestAnimationFrame(updateBoxes);
    }

    highlightRafId = requestAnimationFrame(updateBoxes);
    highlightCleanupTimer = setTimeout(() => {
      if (highlightRafId) cancelAnimationFrame(highlightRafId);
      highlightRafId = null;
      if (highlightLayerEl) highlightLayerEl.innerHTML = '';
    }, DURATION_MS + 60);
  }

  async function checkPendingCrossConversationJump() {
    const pendingBookmark = await consumePendingJump();
    if (!pendingBookmark) return;

    toggleSidebar(true);

    // Wait for the conversation to render, then give ChatGPT a moment to finish its own
    // initial scroll-to-bottom so it does not fight our sweep.
    for (let i = 0; i < 48 && getAllAssistantMessages().length === 0; i++) {
      await sleep(250);
    }
    await sleep(600);

    await runBookmarkJump(pendingBookmark);
  }

  function scheduleSelectionEvaluation(delayMs = 30) {
    if (selectionDebounceTimer) {
      clearTimeout(selectionDebounceTimer);
    }
    selectionDebounceTimer = setTimeout(() => {
      evaluateCurrentSelection();
    }, delayMs);
  }

  function initListeners() {
    // Use capture phase so ChatGPT's internal event handlers cannot swallow mouseup/pointerup
    window.addEventListener(
      'mouseup',
      (e) => {
        if (e.target && e.target.closest && e.target.closest('[data-cgpt-bm-ui="true"]')) {
          return;
        }
        scheduleSelectionEvaluation(25);
      },
      true
    );

    window.addEventListener(
      'pointerup',
      (e) => {
        if (e.target && e.target.closest && e.target.closest('[data-cgpt-bm-ui="true"]')) {
          return;
        }
        scheduleSelectionEvaluation(25);
      },
      true
    );

    window.addEventListener(
      'keyup',
      (e) => {
        if (e.key === 'Escape') {
          hideFloatingButton();
          return;
        }
        if (e.shiftKey || e.key.startsWith('Arrow')) {
          scheduleSelectionEvaluation(25);
        }
      },
      true
    );

    // Also evaluate on selectionchange so any selection method (drag, double-click, touch)
    // reliably surfaces the floating bookmark button
    document.addEventListener('selectionchange', () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        hideFloatingButton();
        return;
      }
      scheduleSelectionEvaluation(90);
    });

    window.addEventListener(
      'scroll',
      (e) => {
        // Ignore scrolls inside the bookmark sidebar itself
        if (e.target && e.target.closest && e.target.closest('[data-cgpt-bm-ui="true"]')) {
          return;
        }
        if (activeSelectionRange) {
          hideFloatingButton();
        }
      },
      true
    );

    // If the user grabs the scroll wheel / touches the screen / presses a key while we are
    // sweeping a long conversation for a bookmark, stop immediately and give control back.
    // (Our own programmatic scrolling does not fire these events.)
    const cancelSearchOnUserInput = (e) => {
      if (!isSearching) return;
      if (e.target && e.target.closest && e.target.closest('[data-cgpt-bm-ui="true"]')) {
        return;
      }
      navToken++;
    };
    window.addEventListener('wheel', cancelSearchOnUserInput, { passive: true, capture: true });
    window.addEventListener('touchstart', cancelSearchOnUserInput, {
      passive: true,
      capture: true
    });
    window.addEventListener('keydown', cancelSearchOnUserInput, true);

    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg && msg.type === 'CGPT_BM_TOGGLE_SIDEBAR') {
          toggleSidebar();
        }
      });
    }

    const themeObserver = new MutationObserver(() => {
      syncThemeClass();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme']
    });

    // --- Keep bookmarks linked to the right chat -------------------------------------------------
    // While URL and on-screen messages agree (see identity.js), link every bookmark whose message
    // is on screen to this chat, let unlinked bookmarks adopt it, and refresh the title label.
    let lastReconcileKey = '';
    let identityBusy = false;
    async function identityTick() {
      if (identityBusy || document.hidden) return;
      identityBusy = true;
      try {
        const snap = identityTracker.poll();

        if (snap.urlId !== currentConversationId) {
          currentConversationId = snap.urlId;
          hideFloatingButton();
          refreshBookmarkList();
        }
        if (!snap.strong) return;

        scheduleLightHealthCheck(snap); // idle, read-only, once per chat; never awaited

        const key = `${snap.urlId}|${snap.idsVersion}|${snap.titleFresh ? snap.title : ''}`;
        if (key === lastReconcileKey) return;
        lastReconcileKey = key;

        const all = await getAllBookmarks();
        const patches = computeIdentityPatches(all, snap, window.location.pathname);
        if (Object.keys(patches).length > 0) {
          await updateBookmarks(patches);
          await refreshBookmarkList();
        }
      } catch (err) {
        console.warn('[ChatGPT Text Bookmarker] Identity check failed:', err);
        lastReconcileKey = ''; // try again next tick
      } finally {
        identityBusy = false;
      }
    }
    setInterval(identityTick, 600);

    // Another tab saved / deleted / re-linked a bookmark -> show it here too.
    let storageRefreshTimer = null;
    onBookmarksChanged(() => {
      clearTimeout(storageRefreshTimer);
      storageRefreshTimer = setTimeout(() => refreshBookmarkList(), 150);
    });

    let lastHref = window.location.href;
    const navObserver = new MutationObserver(() => {
      if (window.location.href !== lastHref) {
        lastHref = window.location.href;
        const nextConvId = getUrlChatId();
        if (nextConvId !== currentConversationId) {
          currentConversationId = nextConvId;
          hideFloatingButton();
          refreshBookmarkList();
        }
      }
    });
    navObserver.observe(document.body, { childList: true, subtree: true });
  }

  async function init() {
    createExtensionUI();
    initListeners();
    try {
      const ui = await getSetting('ui', null);
      if (ui && typeof ui.grouped === 'boolean') groupByChat = ui.grouped;
    } catch {
      // preference only
    }
    await refreshBookmarkList();
    loadHealthState(); // not awaited: the page-check summary must never delay anything
    await checkPendingCrossConversationJump();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
