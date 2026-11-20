# Pinpoint (Chrome Extension — Manifest V3)

A lightweight Chrome Extension that lets you select and bookmark specific sentences, paragraphs, mathematical formulas, or code snippets inside ChatGPT assistant responses—and later click any saved bookmark to scroll directly to and temporarily highlight that exact passage.

## Quick Installation / Reloading (Load Unpacked)

1. Download and extract the extension folder into a folder on your computer.
2. Open Google Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** using the toggle switch in the top-right corner.
4. Click **Load unpacked** in the top-left action bar (or click the **Reload** icon on the existing extension card).
5. Select the extension folder (the folder containing `manifest.json`).
6. Open or refresh [https://chatgpt.com](https://chatgpt.com) and select any text inside an assistant response.

## v1.5.1 — Pinpoint Rebrand & OpenAI Emerald Theme

- **Rebranded to Pinpoint**: Clean, modern identity with updated extension icons across 16px, 48px, and 128px resolutions.
- **OpenAI Emerald Design System**: Refreshed UI tokens to OpenAI's native emerald palette (`#10A37F`), translucent glassmorphism surfaces (`backdrop-filter: blur(20px)`), frosted pill controls, and pulse status indicators.

## Supported ChatGPT DOM Attributes (v1.1)

- Assistant & user roles: `[data-conversation-role="assistant"]`, `[data-chatgpt-search-unit-key$=":assistant"]`, `[data-content-search-unit-key$=":assistant"]`, plus legacy `[data-message-author-role="assistant"]`
- Message & turn identifiers: `[data-chatgpt-search-message-ids]`, `[data-turn-key]`, `[data-chatgpt-search-unit-key]`, `[data-message-id]`
- Content blocks: `[data-d-component]`, `[data-d-text-flow]`, `[data-d-block]`, `[data-d-inline]`, `[data-d-list-item-content]`
- Scroll container: `[data-mcp-app-scroll-host="true"]`, `[data-app-action-timeline-scroll]`

## v1.5.0 — Collections, page check, refreshed sidebar

**Collections.** In *All Chats*, create named collections (e.g. "DCN") and file bookmarks from any number of chats into them with the folder button on each bookmark. A bookmark can be in several collections. Click a collection chip to see only its bookmarks; *Rename* and *Delete collection* appear when one is selected. Deleting a collection removes only the grouping, never the bookmarks.
- Stored as separate keys (`col2:` / `col2m:`), so existing bookmark records are untouched and version 1.4.2 can still read your data (it just ignores collections).
- Included in **Export backup / Import backup** (older backup files still import; importing into a profile that already has a collection with the same name merges into it).

**Page check** (footer row, bottom of the sidebar). Verifies the things the extension relies on and says in plain words which one stopped working if ChatGPT changes its page: responses recognised, page markers, message ids, a real bookmark → find-again round trip, the conversation scroller (full check only) and storage (full check only). It remembers *last healthy* and *problem first seen*. A quiet, read-only light check runs once per chat when the browser is idle and never during a jump; it does not scroll anything. "Run full check" and "Copy report" are in the panel. The report contains no chat text. When something needs attention the Bookmarks button gets a small status dot.

**Sidebar.** Search box (bookmark text, chat title, collection names), collection chips, optional *Group by chat* (remembered), clearer cards, a "more" menu for backup/restore/debug info, and a calmer neutral look with a single accent colour (tokens at the top of `styles.css`). Very long lists draw the newest 200 first with a "Show all" button.

The code that finds and jumps to passages is unchanged from 1.4.2.

## v1.4.2 — More reliable jumps in very long chats (first click, not third)

Found by reading a real "Debug info" dump: a ~122,000 px chat with only ONE message mounted at a time, a saved pixel position larger than the whole current page height (ChatGPT re-estimates heights after a reload), and message ids stored as two ids in one attribute.

- **Removed an unsafe optimisation.** After the "near the bookmark" step the full search used to skip that pixel range. When heights shift while messages are measured, that range no longer holds the same messages, so content could be skipped and never checked. Nothing is skipped by pixel range any more.
- **Saved position is tried by proportion first** (survives re-estimated heights), then by pixels.
- **Waits for the chat to finish loading** before searching.
- **Automatic second pass.** If the fast search does not find the passage, a slower, more careful pass (smaller steps, longer waits for late-mounting or late-filling messages) runs on its own, instead of needing another click.
- **Keeps centering until the passage stays put.** ChatGPT measures neighbouring messages after the scroll and can push the passage out of view (and out of the mounted window); the extension now looks around nearby and re-centers, with a patient check for text that fills in late.
- **Two ids in one attribute** are now handled when linking bookmarks to chats and when finding the message.
- **Debug info** keeps the last 4 jumps (so a failed one can still be copied after a later success). It never contains chat text.
- A missing/regenerated message now takes two passes before "could not find" is shown (you can cancel by scrolling).

## v1.4.1 — Fix: jump to a bookmark failing (false "edited" / not scrolling) until the page is reloaded

Symptoms: right after bookmarking, clicking the bookmark in the same chat showed *"edited or regenerated"*, or showed "searching…" without the page moving and ended with "could not find"; after a reload it worked, but long distances sometimes needed a second click.

Changes (all aimed at things that differ between a live session and a freshly loaded page):
- **The message is now found by its text, using ids only as a hint.** Every element carrying the bookmark's ids is examined (not just the first match), plus every mounted message containing the passage. An element only counts as proof of an edit if it is a real message of the conversation, so an always-present duplicate (side panel, preview...) can no longer cause a false "edited" verdict.
- **The scrolling element is verified, not assumed.** The extension nudges the candidates and uses the one that actually moves the messages; if none proves itself it picks the one that can genuinely scroll. A selector that matched a non-scrolling wrapper used to make the search "scan" without moving.
- **The search builds on where the page really is** after each jump (ChatGPT can shift the scroll position while measuring heights), and a page that will not move is detected and reported within a few seconds with its own message instead of looping.
- **New "Debug info" button** (sidebar footer): copies structural technical details about the last jump (element types, sizes, counts, step log). It contains no chat text or passage text.

## v1.4 — Reliable memory: bookmarks stay in the right chat

**Symptoms fixed:** a bookmark disappearing from its chat and later showing up with an "Other chat" tag; bookmarks silently lost.

**Where your data lives:** `chrome.storage.local` inside your own browser profile. It survives restarts and stays until the extension is removed. No server or database is involved or needed (and none would fix these problems).
> If you load the extension as an *unpacked* folder, **always replace the files in the same folder and press Reload** on `chrome://extensions`. Loading from a different folder creates a *different* extension with an empty store. Use **Export backup** in the sidebar before moving or reinstalling.

**What was wrong and what changed**
- *Chat identity came from the URL alone.* A chat that has no `/c/<id>` yet (new chat, temporary chat, GPT/project home) had every bookmark dropped into one shared "unsaved" bucket, and right after switching chats the URL changes before the screen does, so a bookmark could be filed under the wrong chat. Now a bookmark belongs to its **message** (unique, permanent id). It is linked to a chat only when the URL and the messages on screen demonstrably agree, bookmarks made on a not-yet-saved chat stay "unlinked" and attach themselves when the chat gets its id, and creating a bookmark while the page is mid-navigation is refused with a short message. Renaming a chat changes nothing about identity (the title is only a label).
- *One shared list was rewritten on every change.* Two tabs (or two quick actions) could overwrite each other and silently drop bookmarks. Now each bookmark is its own record, chat links are separate append-only keys, ids are deterministic (saving the same passage twice is harmless), writes are read back to confirm, and failures are shown instead of swallowed.
- Other tabs refresh automatically when bookmarks change.
- New: **Export backup / Import** (merge, never overwrites), **Move here** on bookmarks that are filed under the wrong chat, and the "Other chat" tag now names the chat.
- Your v1.3 data migrates automatically on first load; the old copy is left untouched as a safety net.

## v1.3 — Fix: bookmarks in very long conversations

**Symptom:** clicking a bookmark in a long chat showed *"This response was edited or regenerated and no longer contains the bookmarked passage"* or *"could not be found"*, even though nothing had changed.

**Cause:** ChatGPT virtualizes long conversations, so messages far from the viewport are not in the DOM. The old code (a) could not find the unmounted message, and (b) fell back to a saved turn *index* that only counted the currently-mounted messages, so it pointed at an unrelated response and misreported it as "edited".

**How it works now**
- Lookup is by message / turn IDs only (the unreliable turn-index fallback is gone). Empty virtualized shells count as "not mounted".
- Every new bookmark stores a scroll-position hint. When the target isn't mounted:
  1. Check exactly at the hinted position (usually instant).
  2. Scan a small window around it, scrolling **downward only**.
  3. If still not found, one full pass from the **top to the bottom** of the conversation.
- The pass is single-direction (no alternating up/down), so the page loads messages in natural reading order.
- After every move the extension waits until the page has *settled*: the visible area is filled with rendered messages from top to bottom, and the DOM and scroll height have stopped changing. A fixed delay (or a half-filled screen left over from the previous position) caused misses.
- Steps "gallop": they grow while consecutive screens overlap, and if a jump lands on a screen that shares no messages with the previous one (something may have been skipped) the extension backs up, halves the jump and stops trusting jumps that size.
- Scrolling, touching or typing while it searches cancels the search. A toast shows live progress.
- "Edited or regenerated" is only shown when the *correct* message is rendered and truly lacks the passage. Otherwise you get an accurate "could not find" message and your scroll position is restored.
- Bookmarks made with v1.1 still work; they have no hint, so the first jump does the full top-to-bottom pass.
- The highlight re-attaches itself if ChatGPT re-renders the message while it is shown.
