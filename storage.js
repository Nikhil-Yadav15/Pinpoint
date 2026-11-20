/**
 * ChatGPT Text Bookmarker — Persistent Storage Engine (schema v2)
 *
 * Primary store: chrome.storage.local (survives browser restarts, lives with the extension until it
 * is uninstalled; "unlimitedStorage" lifts the default quota). IndexedDB is only a fallback for
 * environments without chrome.storage.
 *
 * Design rules (each one fixes a real failure of the old single-array design):
 *  1. ONE RECORD PER BOOKMARK under its own key ("bm2:<id>"). Saving or deleting touches only that
 *     key, so two tabs / two quick actions can no longer overwrite each other's work (the old code
 *     rewrote the whole list on every change: read list -> modify -> write list = lost updates).
 *  2. DETERMINISTIC IDs. The same passage always maps to the same key, so saving it twice -- even
 *     from two tabs at once -- is idempotent instead of producing duplicates or conflicts.
 *  3. WRITES CAN FAIL LOUDLY. Errors (quota, disconnected extension context) are surfaced instead of
 *     being swallowed, and a save is read back to confirm it really persisted.
 *  4. A bookmark belongs to its MESSAGE (unique, permanent id). The chats it is linked to are a set
 *     that grows by observation, stored as append-only link keys so concurrent tabs cannot erase
 *     each other. Chat titles are cosmetic only.
 *  5. The legacy v1 array is migrated once and left untouched as a backup.
 */
(function () {
  'use strict';

  const LEGACY_KEY = 'cgpt_text_bookmarks_v1';
  const PENDING_JUMP_KEY = 'cgpt_pending_jump_v1';
  const REC_PREFIX = 'bm2:';
  const LINK_PREFIX = 'bm2l:';
  // Collections (v1.5): separate keys, so existing bookmark records are never modified and an older
  // version simply ignores them.
  const COL_PREFIX = 'col2:'; // col2:<collectionId>            -> { id, name, createdAt }
  const COLM_PREFIX = 'col2m:'; // col2m:<collectionId>:<bookmarkId> -> { t }  (membership, append-only)
  const CFG_PREFIX = 'cfg:'; // small settings / status values
  const META_KEY = 'bm2_meta';
  const LEGACY_ROOT = 'unsaved-root-chat';
  const EXPORT_APP = 'chatgpt-text-bookmarker';
  const IDB_NAME = 'ChatGPTTextBookmarkerDB';
  const IDB_STORE = 'kv_store';

  // ---------------------------------------------------------------------------
  // Key-value layer (chrome.storage.local, IndexedDB fallback)
  // ---------------------------------------------------------------------------

  function hasChromeStorage() {
    return Boolean(typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local);
  }

  function chromeCall(invoke) {
    return new Promise((resolve, reject) => {
      try {
        invoke((result) => {
          const err = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError;
          if (err) reject(new Error(err.message || 'chrome.storage error'));
          else resolve(result);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function openIndexedDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(IDB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function idbTx(mode, work) {
    const db = await openIndexedDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, mode);
      const store = tx.objectStore(IDB_STORE);
      let out;
      try {
        out = work(store);
      } catch (e) {
        reject(e);
        return;
      }
      tx.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  const kv = {
    async getAll() {
      if (hasChromeStorage()) {
        return (await chromeCall((cb) => chrome.storage.local.get(null, cb))) || {};
      }
      const db = await openIndexedDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const store = tx.objectStore(IDB_STORE);
        const keysReq = store.getAllKeys();
        const valsReq = store.getAll();
        tx.oncomplete = () => {
          const out = {};
          keysReq.result.forEach((k, i) => (out[k] = valsReq.result[i]));
          resolve(out);
        };
        tx.onerror = () => reject(tx.error);
      });
    },

    async get(key) {
      if (hasChromeStorage()) {
        const res = await chromeCall((cb) => chrome.storage.local.get([key], cb));
        return res ? res[key] : undefined;
      }
      const db = await openIndexedDB();
      return new Promise((resolve, reject) => {
        const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    },

    async set(obj) {
      if (hasChromeStorage()) {
        await chromeCall((cb) => chrome.storage.local.set(obj, cb));
        return;
      }
      await idbTx('readwrite', (store) => {
        for (const [k, v] of Object.entries(obj)) store.put(v, k);
      });
    },

    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      if (hasChromeStorage()) {
        await chromeCall((cb) => chrome.storage.local.remove(list, cb));
        return;
      }
      await idbTx('readwrite', (store) => {
        for (const k of list) store.delete(k);
      });
    }
  };

  // Serialise this tab's own read-modify-write sequences (cross-tab safety comes from per-record keys).
  let chain = Promise.resolve();
  function serialize(fn) {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  }

  // ---------------------------------------------------------------------------
  // Records
  // ---------------------------------------------------------------------------

  function hash53(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0, ch; i < str.length; i++) {
      ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }

  /** Same passage in the same message -> same id, from any tab, any time. */
  function bookmarkIdFor(a) {
    const anchorKey =
      a.messageId ||
      a.turnKey ||
      a.searchUnitKey ||
      'conv:' + (a.conversationId || 'none') + ':' + (typeof a.turnIndex === 'number' ? a.turnIndex : -1);
    const raw = [anchorKey, a.startOffset, a.endOffset, a.selectedText].join('\u0001');
    return 'bm_' + hash53(raw).toString(36);
  }

  function union(a, b) {
    return [...new Set([...(a || []), ...(b || [])])];
  }

  /** Brings any record (v1 or v2, possibly partial) to the v2 shape. Returns null if unusable. */
  function normalizeRecord(raw) {
    if (!raw || typeof raw !== 'object' || !raw.id || typeof raw.selectedText !== 'string') {
      return null;
    }
    let primary = raw.conversationId;
    if (!primary || primary === LEGACY_ROOT) primary = null; // legacy shared "unsaved" bucket -> unknown
    const ids = (Array.isArray(raw.conversationIds) ? raw.conversationIds : []).filter(
      (x) => typeof x === 'string' && x && x !== LEGACY_ROOT
    );
    if (primary && !ids.includes(primary)) ids.unshift(primary);

    return {
      ...raw,
      conversationId: primary,
      conversationIds: [...new Set(ids)],
      sessionId: raw.sessionId || null,
      conversationTitle: raw.conversationTitle || 'ChatGPT Conversation',
      schema: 2
    };
  }

  // ---------------------------------------------------------------------------
  // Migration (v1 single array -> v2 records). Idempotent; the v1 data is kept as a backup.
  // ---------------------------------------------------------------------------

  let migrationPromise = null;

  async function migrate() {
    const meta = await kv.get(META_KEY);
    if (meta && meta.legacyMigrated) return;

    const legacy = await kv.get(LEGACY_KEY);
    const toWrite = {};
    if (Array.isArray(legacy) && legacy.length > 0) {
      const existing = await kv.getAll();
      for (const raw of legacy) {
        const rec = normalizeRecord(raw);
        if (!rec) continue;
        const key = REC_PREFIX + rec.id;
        if (!(key in existing)) toWrite[key] = rec; // never overwrite newer data
      }
    }
    toWrite[META_KEY] = {
      schema: 2,
      legacyMigrated: true,
      migratedAt: Date.now(),
      legacyCount: Array.isArray(legacy) ? legacy.length : 0
    };
    await kv.set(toWrite);
  }

  function ensureMigrated() {
    if (!migrationPromise) {
      migrationPromise = migrate().catch((err) => {
        migrationPromise = null; // retry next time instead of staying broken
        throw err;
      });
    }
    return migrationPromise;
  }

  // ---------------------------------------------------------------------------
  // Chat links: membership is stored as SEPARATE append-only keys ("bm2l:<bookmarkId>:<chatId>").
  // Two tabs that link the same bookmark to different chats at the same moment write different
  // keys, so neither can erase the other -- a conflict-free set, no locking needed. (Putting the
  // list inside the record would reintroduce read-modify-write races.)
  // ---------------------------------------------------------------------------

  const linkKey = (bookmarkId, chatId) => `${LINK_PREFIX}${bookmarkId}:${chatId}`;

  function collectLinks(items) {
    const byBookmark = {};
    for (const key of Object.keys(items)) {
      if (!key.startsWith(LINK_PREFIX)) continue;
      const rest = key.slice(LINK_PREFIX.length);
      const i = rest.indexOf(':');
      if (i < 1) continue;
      const bookmarkId = rest.slice(0, i);
      (byBookmark[bookmarkId] = byBookmark[bookmarkId] || []).push(rest.slice(i + 1));
    }
    return byBookmark;
  }

  function withLinks(raw, links) {
    if (!raw || typeof raw !== 'object') return raw;
    return { ...raw, conversationIds: union(raw.conversationIds, links[raw.id]) };
  }

  function linkKeysOf(items, bookmarkId) {
    const prefix = `${LINK_PREFIX}${bookmarkId}:`;
    return Object.keys(items).filter((k) => k.startsWith(prefix));
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  function bookmarksFromItems(items) {
    const links = collectLinks(items);
    const list = [];
    for (const [key, value] of Object.entries(items)) {
      if (!key.startsWith(REC_PREFIX)) continue;
      const rec = normalizeRecord(withLinks(value, links));
      if (rec) list.push(rec);
    }
    list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return list;
  }

  /** All bookmarks, newest first. */
  async function getAllBookmarks() {
    await ensureMigrated();
    return bookmarksFromItems(await kv.getAll());
  }

  // ---------------------------------------------------------------------------
  // Collections ("DCN", "OS", ...): named groups that can contain bookmarks from ANY chats.
  // A collection is a record + one append-only membership key per bookmark, so adding to a
  // collection from two tabs at once cannot lose anything, and deleting a collection only removes
  // the grouping -- never a bookmark.
  // ---------------------------------------------------------------------------

  const colMemberKey = (collectionId, bookmarkId) => `${COLM_PREFIX}${collectionId}:${bookmarkId}`;

  function cleanCollectionName(name) {
    const clean = String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
    if (!clean) throw new Error('Please enter a name.');
    if (clean.length > 40) throw new Error('Names can be at most 40 characters.');
    return clean;
  }

  function collectionMembers(items) {
    const byCollection = {};
    for (const key of Object.keys(items)) {
      if (!key.startsWith(COLM_PREFIX)) continue;
      const rest = key.slice(COLM_PREFIX.length);
      const i = rest.indexOf(':');
      if (i < 1) continue;
      const collectionId = rest.slice(0, i);
      (byCollection[collectionId] = byCollection[collectionId] || []).push(rest.slice(i + 1));
    }
    return byCollection;
  }

  function collectionsFromItems(items, bookmarkIds) {
    const members = collectionMembers(items);
    const list = [];
    for (const [key, value] of Object.entries(items)) {
      if (!key.startsWith(COL_PREFIX) || !value || !value.id || typeof value.name !== 'string') continue;
      list.push({
        id: value.id,
        name: value.name,
        createdAt: value.createdAt || 0,
        // links to bookmarks that no longer exist (deleted in another tab) are ignored
        bookmarkIds: (members[value.id] || []).filter((id) => bookmarkIds.has(id))
      });
    }
    list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    return list;
  }

  /** Bookmarks AND collections from ONE storage read (opening the sidebar costs one read). */
  async function getLibrary() {
    await ensureMigrated();
    const items = await kv.getAll();
    const bookmarks = bookmarksFromItems(items);
    const collections = collectionsFromItems(items, new Set(bookmarks.map((b) => b.id)));
    return { bookmarks, collections };
  }

  /** Creates a collection (or returns the existing one with the same name, ignoring case). */
  function createCollection(name) {
    return serialize(async () => {
      const clean = cleanCollectionName(name);
      const items = await kv.getAll();
      for (const [key, value] of Object.entries(items)) {
        if (key.startsWith(COL_PREFIX) && value && String(value.name).toLowerCase() === clean.toLowerCase()) {
          return { collection: value, existed: true };
        }
      }
      const collection = {
        id: 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: clean,
        createdAt: Date.now()
      };
      await kv.set({ [COL_PREFIX + collection.id]: collection });
      return { collection, existed: false };
    });
  }

  function renameCollection(collectionId, name) {
    return serialize(async () => {
      const clean = cleanCollectionName(name);
      const items = await kv.getAll();
      const current = items[COL_PREFIX + collectionId];
      if (!current) throw new Error('This collection no longer exists.');
      for (const [key, value] of Object.entries(items)) {
        if (
          key.startsWith(COL_PREFIX) &&
          value.id !== collectionId &&
          String(value.name).toLowerCase() === clean.toLowerCase()
        ) {
          throw new Error('A collection with that name already exists.');
        }
      }
      await kv.set({ [COL_PREFIX + collectionId]: { ...current, name: clean } });
      return true;
    });
  }

  /** Removes the collection and its groupings only. Bookmarks are never touched. */
  function deleteCollection(collectionId) {
    return serialize(async () => {
      const items = await kv.getAll();
      const prefix = `${COLM_PREFIX}${collectionId}:`;
      await kv.remove([COL_PREFIX + collectionId, ...Object.keys(items).filter((k) => k.startsWith(prefix))]);
      return true;
    });
  }

  function addToCollection(collectionId, bookmarkId) {
    return serialize(async () => {
      if (!(await kv.get(COL_PREFIX + collectionId))) throw new Error('This collection no longer exists.');
      await kv.set({ [colMemberKey(collectionId, bookmarkId)]: { t: Date.now() } });
      return true;
    });
  }

  function removeFromCollection(collectionId, bookmarkId) {
    return serialize(async () => {
      await kv.remove(colMemberKey(collectionId, bookmarkId));
      return true;
    });
  }

  // ---------------------------------------------------------------------------
  // Small settings / status values (UI preferences, page-check status)
  // ---------------------------------------------------------------------------

  async function getSetting(name, fallback) {
    try {
      const value = await kv.get(CFG_PREFIX + name);
      return value === undefined ? fallback : value;
    } catch {
      return fallback;
    }
  }

  async function setSetting(name, value) {
    await kv.set({ [CFG_PREFIX + name]: value });
  }

  /** Write -> read back -> delete a throw-away value. Used by the page check. */
  async function probeStorage() {
    const key = CFG_PREFIX + 'probe';
    const stamp = Date.now();
    await kv.set({ [key]: stamp });
    const back = await kv.get(key);
    await kv.remove(key);
    if (back !== stamp) throw new Error('storage did not return what was written');
    return true;
  }

  /** Bookmarks linked to a chat id. */
  async function getBookmarksByConversation(conversationId) {
    const all = await getAllBookmarks();
    return all.filter((bm) => bm.conversationIds.includes(conversationId));
  }

  /**
   * Saves a bookmark. Saving the same passage again is idempotent (returns the existing record,
   * and links it to the current chat if that is new information).
   */
  function saveBookmark(anchorData) {
    return serialize(async () => {
      await ensureMigrated();

      const id = bookmarkIdFor(anchorData);
      const key = REC_PREFIX + id;
      const chatId = anchorData.conversationId || null;

      const existing = normalizeRecord(await kv.get(key));
      if (existing) {
        const toWrite = {};
        let rec = existing;
        if (chatId) {
          toWrite[linkKey(id, chatId)] = { t: Date.now() };
          rec = normalizeRecord({
            ...existing,
            conversationId: existing.conversationId || chatId,
            conversationIds: union(existing.conversationIds, [chatId])
          });
          if (existing.conversationId === null) toWrite[key] = rec;
        }
        if (Object.keys(toWrite).length > 0) await kv.set(toWrite);
        return { bookmark: rec, isDuplicate: true };
      }

      const rec = normalizeRecord({
        id,
        conversationId: chatId,
        conversationIds: chatId ? [chatId] : [],
        sessionId: anchorData.sessionId || null,
        conversationTitle: anchorData.conversationTitle || 'ChatGPT Conversation',
        conversationPath: anchorData.conversationPath || window.location.pathname,
        messageId: anchorData.messageId || null,
        turnKey: anchorData.turnKey || null,
        searchUnitKey: anchorData.searchUnitKey || null,
        turnTestId: anchorData.turnTestId || null,
        turnIndex: typeof anchorData.turnIndex === 'number' ? anchorData.turnIndex : -1,
        selectedText: anchorData.selectedText,
        normalizedText: anchorData.normalizedText,
        prefixContext: anchorData.prefixContext || '',
        suffixContext: anchorData.suffixContext || '',
        startOffset: anchorData.startOffset,
        endOffset: anchorData.endOffset,
        responseFingerprint: anchorData.responseFingerprint,
        scrollOffsetPx:
          typeof anchorData.scrollOffsetPx === 'number' ? anchorData.scrollOffsetPx : null,
        scrollRatio: typeof anchorData.scrollRatio === 'number' ? anchorData.scrollRatio : null,
        createdAt: Date.now()
      });

      const toWrite = { [key]: rec };
      if (chatId) toWrite[linkKey(id, chatId)] = { t: Date.now() };
      await kv.set(toWrite);

      const readBack = await kv.get(key); // confirm it really persisted
      if (!readBack) throw new Error('The browser did not keep the bookmark (storage write failed).');
      return { bookmark: rec, isDuplicate: false };
    });
  }

  /**
   * Applies partial updates { [bookmarkId]: patch }. New chat links go to their own keys (can never
   * be erased by another tab); other fields (title, path, primary chat) are last-writer-wins,
   * which is harmless because they are cosmetic or idempotent.
   */
  function updateBookmarks(patches) {
    return serialize(async () => {
      await ensureMigrated();
      const toWrite = {};
      let count = 0;

      for (const [id, patch] of Object.entries(patches || {})) {
        const key = REC_PREFIX + id;
        const current = normalizeRecord(await kv.get(key));
        if (!current) continue; // deleted meanwhile: do not resurrect it

        const { conversationIds, ...fields } = patch;
        const newLinks = [...new Set([...(conversationIds || []), ...(patch.conversationId ? [patch.conversationId] : [])])];
        for (const chatId of newLinks) toWrite[linkKey(id, chatId)] = { t: Date.now() };

        if (Object.keys(fields).length > 0) {
          toWrite[key] = normalizeRecord({
            ...current,
            ...fields,
            id: current.id,
            conversationIds: union(current.conversationIds, newLinks)
          });
        }
        count++;
      }

      if (Object.keys(toWrite).length > 0) await kv.set(toWrite);
      return count;
    });
  }

  /** Re-files a bookmark under exactly one chat (manual correction). */
  function moveBookmarkToChat(bookmarkId, chatId, extra) {
    return serialize(async () => {
      const key = REC_PREFIX + bookmarkId;
      const current = normalizeRecord(await kv.get(key));
      if (!current) return false;

      const items = await kv.getAll();
      const stale = linkKeysOf(items, bookmarkId).filter((k) => k !== linkKey(bookmarkId, chatId));
      if (stale.length > 0) await kv.remove(stale);

      await kv.set({
        [key]: normalizeRecord({
          ...current,
          ...(extra || {}),
          conversationId: chatId,
          conversationIds: [chatId]
        }),
        [linkKey(bookmarkId, chatId)]: { t: Date.now() }
      });
      return true;
    });
  }

  function deleteBookmark(bookmarkId) {
    return serialize(async () => {
      const items = await kv.getAll();
      const collectionLinks = Object.keys(items).filter(
        (k) => k.startsWith(COLM_PREFIX) && k.endsWith(':' + bookmarkId)
      );
      await kv.remove([REC_PREFIX + bookmarkId, ...linkKeysOf(items, bookmarkId), ...collectionLinks]);
      return true;
    });
  }

  /** Calls cb whenever bookmarks change in ANY tab. Returns an unsubscribe function. */
  function onBookmarksChanged(cb) {
    if (!hasChromeStorage() || !chrome.storage.onChanged) return () => {};
    const listener = (changes, area) => {
      if (area !== 'local') return;
      if (
        Object.keys(changes).some(
          (k) =>
            k.startsWith(REC_PREFIX) ||
            k.startsWith(LINK_PREFIX) ||
            k.startsWith(COL_PREFIX) ||
            k.startsWith(COLM_PREFIX)
        )
      ) {
        cb();
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => {
      if (chrome.storage.onChanged.removeListener) chrome.storage.onChanged.removeListener(listener);
    };
  }

  // ---------------------------------------------------------------------------
  // Backup / restore
  // ---------------------------------------------------------------------------

  async function exportAll() {
    const { bookmarks, collections } = await getLibrary();
    return {
      app: EXPORT_APP,
      schema: 3,
      exportedAt: new Date().toISOString(),
      count: bookmarks.length,
      bookmarks,
      collections // optional on import: files from older versions simply have none
    };
  }

  /** Merges an export (or a raw v1 array) into the store. Existing bookmarks are never overwritten. */
  function importBookmarks(payload) {
    const list = Array.isArray(payload)
      ? payload
      : payload && Array.isArray(payload.bookmarks)
        ? payload.bookmarks
        : null;
    if (!list) return Promise.reject(new Error('This file is not a bookmark export.'));

    return serialize(async () => {
      await ensureMigrated();
      const existing = await kv.getAll();
      const existingLinks = collectLinks(existing);
      const toWrite = {};
      let added = 0;
      let merged = 0;
      let invalid = 0;

      for (const raw of list) {
        const withId =
          raw && typeof raw === 'object' && !raw.id && raw.selectedText
            ? { ...raw, id: bookmarkIdFor(raw) }
            : raw;
        const rec = normalizeRecord(withId);
        if (!rec) {
          invalid++;
          continue;
        }
        const key = REC_PREFIX + rec.id;
        const current = toWrite[key] || existing[key];

        if (!current) {
          toWrite[key] = rec;
          for (const chatId of rec.conversationIds) toWrite[linkKey(rec.id, chatId)] = { t: Date.now() };
          added++;
        } else {
          const have = new Set(union(normalizeRecord(current).conversationIds, existingLinks[rec.id]));
          let changed = false;
          for (const chatId of rec.conversationIds) {
            if (!have.has(chatId)) {
              toWrite[linkKey(rec.id, chatId)] = { t: Date.now() };
              have.add(chatId);
              changed = true;
            }
          }
          if (changed) merged++;
        }
      }

      // ---- collections (optional section of the file) ----
      let collectionsAdded = 0;
      let collectionLinks = 0;
      const fileCollections = Array.isArray(payload && payload.collections) ? payload.collections : [];
      if (fileCollections.length > 0) {
        const knownBookmarks = new Set([
          ...Object.keys(existing).filter((k) => k.startsWith(REC_PREFIX)).map((k) => k.slice(REC_PREFIX.length)),
          ...Object.keys(toWrite).filter((k) => k.startsWith(REC_PREFIX)).map((k) => k.slice(REC_PREFIX.length))
        ]);
        const byId = {};
        const byName = {};
        for (const [key, value] of Object.entries(existing)) {
          if (key.startsWith(COL_PREFIX) && value && value.id) {
            byId[value.id] = value;
            byName[String(value.name).toLowerCase()] = value;
          }
        }

        for (const raw of fileCollections) {
          if (!raw || typeof raw.name !== 'string' || !raw.name.trim()) continue;
          let name;
          try {
            name = cleanCollectionName(raw.name);
          } catch {
            continue;
          }
          // Same collection if it has the same id, otherwise the same name (so importing a backup
          // into a profile that already has "DCN" merges instead of creating a second "DCN").
          let target = (raw.id && byId[raw.id]) || byName[name.toLowerCase()];
          if (!target) {
            target = {
              id: typeof raw.id === 'string' && raw.id ? raw.id : 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
              name,
              createdAt: raw.createdAt || Date.now()
            };
            toWrite[COL_PREFIX + target.id] = target;
            byId[target.id] = target;
            byName[name.toLowerCase()] = target;
            collectionsAdded++;
          }
          for (const bookmarkId of Array.isArray(raw.bookmarkIds) ? raw.bookmarkIds : []) {
            if (typeof bookmarkId !== 'string' || !knownBookmarks.has(bookmarkId)) continue;
            const key = colMemberKey(target.id, bookmarkId);
            if (!(key in existing) && !(key in toWrite)) {
              toWrite[key] = { t: Date.now() };
              collectionLinks++;
            }
          }
        }
      }

      if (Object.keys(toWrite).length > 0) await kv.set(toWrite);
      return {
        added,
        merged,
        invalid,
        skipped: list.length - added - merged - invalid,
        collectionsAdded,
        collectionLinks
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Cross-chat navigation hand-off
  // ---------------------------------------------------------------------------

  async function setPendingJump(bookmarkId) {
    await kv.set({ [PENDING_JUMP_KEY]: { bookmarkId, timestamp: Date.now() } });
  }

  async function consumePendingJump() {
    const pending = await kv.get(PENDING_JUMP_KEY);
    if (!pending || !pending.bookmarkId) return null;
    await kv.remove(PENDING_JUMP_KEY);
    if (Date.now() - (pending.timestamp || 0) > 30000) return null;
    const all = await getAllBookmarks();
    return all.find((bm) => bm.id === pending.bookmarkId) || null;
  }

  window.CGPTBookmarkerStorage = {
    getAllBookmarks,
    getLibrary,
    getBookmarksByConversation,
    saveBookmark,
    updateBookmarks,
    moveBookmarkToChat,
    deleteBookmark,
    createCollection,
    renameCollection,
    deleteCollection,
    addToCollection,
    removeFromCollection,
    getSetting,
    setSetting,
    probeStorage,
    onBookmarksChanged,
    exportAll,
    importBookmarks,
    setPendingJump,
    consumePendingJump
  };
})();
