# Pinpoint

Pinpoint lets you bookmark exact sentences, code snippets, and formulas inside ChatGPT responses—and jump straight back to them in one click.

### Why not just use browser bookmarks?

Long ChatGPT threads get messy. Once a conversation grows past a few dozen messages, finding an earlier code block or explanation is a hassle:

- **Browser bookmarks only save the chat URL**, dropping you at the top of the page.
- **`Ctrl+F` fails in long chats** because ChatGPT virtualizes messages—off-screen text does not exist in the DOM until you scroll near it.
- **Standard chat bookmark extensions break** when messages reload, or they rely on fragile turn counts that drift after re-renders.

Pinpoint anchors directly to message IDs and navigates ChatGPT's virtual scroller, bringing you straight back to your passage every time.

### What it does

- **Select & Pin**: Highlight any text in an assistant response and click the floating bookmark button.
- **Deep Jumps**: Scrolls directly to your passage, even in long conversations where ChatGPT unloads off-screen messages.
- **Passage Highlight**: Pulses an emerald glow over the target text so you never lose your place.
- **Collections**: Group bookmarks across chats (e.g. `Regex`, `Math`, `Prompts`) to organize your notes.
- **100% Local**: No accounts, no backend, no telemetry. Everything lives in your browser's local storage.

### Install

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this folder.
4. Open [chatgpt.com](https://chatgpt.com), select any response text, and click the bookmark button.
