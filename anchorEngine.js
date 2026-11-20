/**
 * ChatGPT Text Bookmarker — Text Anchor & Range Reconstruction Engine (v1.1)
 *
 * Implements deterministic DOM TextNode mapping across ChatGPT's [data-d-component],
 * [data-d-text-flow], [data-d-block], and [data-d-inline] nodes, FNV-1a response
 * fingerprinting, surrounding context (prefix/suffix) disambiguation for repeated sentences,
 * and cross-element Range reconstruction.
 */
(function () {
  'use strict';

  const CONTEXT_RADIUS = 64;

  /**
   * Fast 32-bit FNV-1a hash combined with string length for response fingerprinting.
   */
  function computeFingerprint(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    const unsigned = (hash >>> 0).toString(16).padStart(8, '0');
    return `${unsigned}:${text.length}`;
  }

  /**
   * Collapses runs of whitespace into single spaces.
   */
  function normalizeWhitespace(str) {
    return (str || '').replace(/\s+/g, ' ');
  }

  /**
   * Checks whether a Text node should be excluded from the response text map.
   */
  function isNodeExcluded(textNode, rootEl) {
    let el = textNode.parentElement;
    const excludedSelector =
      window.CGPTBookmarkerSelectors.SELECTORS.excludedSubtrees.join(', ');

    while (el && el !== rootEl) {
      if (el.matches && el.matches(excludedSelector)) {
        return true;
      }
      el = el.parentElement;
    }
    return false;
  }

  /**
   * Walks all accepted DOM Text nodes inside an assistant response container and builds:
   * - entries: [{ node, rawStart, rawEnd, text }]
   * - rawText: concatenated raw text across all Text nodes
   * - normText: whitespace-normalized text
   * - rawToNorm: Int32Array mapping each raw index -> normalized index
   * - normToRawStart / normToRawEnd: arrays mapping each normalized char -> raw indices
   */
  function buildResponseTextMap(containerEl) {
    const entries = [];
    let rawText = '';

    const walker = document.createTreeWalker(
      containerEl,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (!node.nodeValue || node.nodeValue.length === 0) {
            return NodeFilter.FILTER_SKIP;
          }
          if (isNodeExcluded(node, containerEl)) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let currentNode = walker.nextNode();
    while (currentNode) {
      const val = currentNode.nodeValue;
      const rawStart = rawText.length;
      rawText += val;
      const rawEnd = rawText.length;
      entries.push({
        node: currentNode,
        rawStart,
        rawEnd,
        text: val
      });
      currentNode = walker.nextNode();
    }

    const rawLen = rawText.length;
    const rawToNorm = new Int32Array(rawLen + 1);
    const normToRawStart = [];
    const normToRawEnd = [];
    const normChars = [];
    let inWhitespace = false;

    for (let i = 0; i < rawLen; i++) {
      const ch = rawText[i];
      const isWs = /\s/.test(ch);
      rawToNorm[i] = normChars.length;

      if (isWs) {
        if (!inWhitespace) {
          normToRawStart.push(i);
          normToRawEnd.push(i + 1);
          normChars.push(' ');
          inWhitespace = true;
        } else {
          normToRawEnd[normToRawEnd.length - 1] = i + 1;
        }
      } else {
        normToRawStart.push(i);
        normToRawEnd.push(i + 1);
        normChars.push(ch);
        inWhitespace = false;
      }
    }
    rawToNorm[rawLen] = normChars.length;

    const normText = normChars.join('');

    return {
      entries,
      rawText,
      normText,
      rawToNorm,
      normToRawStart,
      normToRawEnd
    };
  }

  /**
   * Resolves a DOM boundary (container, offset) from a Range into a character index
   * within rawText. Handles both Text node boundaries and Element node boundaries.
   */
  function resolveRangeBoundaryToRawOffset(range, isStart, textMap) {
    const boundaryNode = isStart ? range.startContainer : range.endContainer;
    const boundaryOffset = isStart ? range.startOffset : range.endOffset;

    for (let i = 0; i < textMap.entries.length; i++) {
      const entry = textMap.entries[i];
      if (entry.node === boundaryNode) {
        const clamped = Math.max(0, Math.min(boundaryOffset, entry.text.length));
        return entry.rawStart + clamped;
      }
    }

    for (let i = 0; i < textMap.entries.length; i++) {
      const entry = textMap.entries[i];
      try {
        const cmpStart = range.comparePoint(entry.node, 0);
        const cmpEnd = range.comparePoint(entry.node, entry.text.length);

        if (isStart) {
          if (cmpEnd >= 0) {
            return cmpStart >= 0 ? entry.rawStart : entry.rawEnd;
          }
        } else {
          if (cmpEnd > 0) {
            return cmpStart > 0 ? entry.rawStart : entry.rawEnd;
          }
        }
      } catch {
        // Ignore detached subtrees
      }
    }

    return isStart ? 0 : textMap.rawText.length;
  }

  /**
   * Creates a serializable bookmark anchor object from a user's active Selection Range
   * inside an assistant response container.
   */
  function createBookmarkAnchor(range, containerEl) {
    const selectedText = range.toString();
    if (!selectedText || !selectedText.trim()) {
      return null;
    }

    const textMap = buildResponseTextMap(containerEl);
    if (!textMap.normText) {
      return null;
    }

    let rawStart = resolveRangeBoundaryToRawOffset(range, true, textMap);
    let rawEnd = resolveRangeBoundaryToRawOffset(range, false, textMap);

    if (rawEnd < rawStart) {
      const tmp = rawStart;
      rawStart = rawEnd;
      rawEnd = tmp;
    }

    while (rawStart < rawEnd && /\s/.test(textMap.rawText[rawStart])) {
      rawStart++;
    }
    while (rawEnd > rawStart && /\s/.test(textMap.rawText[rawEnd - 1])) {
      rawEnd--;
    }

    const startOffset = textMap.rawToNorm[rawStart];
    const endOffset = textMap.rawToNorm[rawEnd];
    const normalizedText = textMap.normText.slice(startOffset, endOffset).trim();

    const prefixContext = textMap.normText.slice(
      Math.max(0, startOffset - CONTEXT_RADIUS),
      startOffset
    );
    const suffixContext = textMap.normText.slice(
      endOffset,
      Math.min(textMap.normText.length, endOffset + CONTEXT_RADIUS)
    );

    const responseFingerprint = computeFingerprint(textMap.normText);
    const meta = window.CGPTBookmarkerSelectors.getAssistantMessageMeta(containerEl);

    return {
      conversationId: window.CGPTBookmarkerSelectors.getUrlChatId(),
      conversationTitle: window.CGPTBookmarkerSelectors.getConversationTitle(),
      conversationPath: window.location.pathname,
      messageId: meta.messageId,
      turnKey: meta.turnKey,
      searchUnitKey: meta.searchUnitKey,
      turnTestId: meta.turnTestId,
      turnIndex: meta.turnIndex,
      selectedText: selectedText.trim(),
      normalizedText: normalizedText || normalizeWhitespace(selectedText).trim(),
      prefixContext,
      suffixContext,
      startOffset,
      endOffset,
      responseFingerprint
    };
  }

  function scorePrefixSimilarity(expectedPrefix, actualPrefix) {
    if (!expectedPrefix && !actualPrefix) return 1;
    if (!expectedPrefix || !actualPrefix) return 0.5;

    const len = Math.min(expectedPrefix.length, actualPrefix.length);
    if (len === 0) return 0;

    let matches = 0;
    for (let i = 1; i <= len; i++) {
      if (expectedPrefix[expectedPrefix.length - i] === actualPrefix[actualPrefix.length - i]) {
        matches++;
      }
    }
    return matches / Math.max(expectedPrefix.length, actualPrefix.length);
  }

  function scoreSuffixSimilarity(expectedSuffix, actualSuffix) {
    if (!expectedSuffix && !actualSuffix) return 1;
    if (!expectedSuffix || !actualSuffix) return 0.5;

    const len = Math.min(expectedSuffix.length, actualSuffix.length);
    if (len === 0) return 0;

    let matches = 0;
    for (let i = 0; i < len; i++) {
      if (expectedSuffix[i] === actualSuffix[i]) {
        matches++;
      }
    }
    return matches / Math.max(expectedSuffix.length, actualSuffix.length);
  }

  function createRangeFromRawOffsets(rawStart, rawEnd, textMap) {
    if (textMap.entries.length === 0 || rawEnd <= rawStart) {
      return null;
    }

    let startNode = null;
    let startNodeOffset = 0;
    let endNode = null;
    let endNodeOffset = 0;

    for (let i = 0; i < textMap.entries.length; i++) {
      const entry = textMap.entries[i];
      if (!startNode && rawStart >= entry.rawStart && rawStart <= entry.rawEnd) {
        if (rawStart === entry.rawEnd && i + 1 < textMap.entries.length) {
          startNode = textMap.entries[i + 1].node;
          startNodeOffset = 0;
        } else {
          startNode = entry.node;
          startNodeOffset = rawStart - entry.rawStart;
        }
      }
      if (rawEnd >= entry.rawStart && rawEnd <= entry.rawEnd) {
        endNode = entry.node;
        endNodeOffset = rawEnd - entry.rawStart;
        if (rawEnd > entry.rawStart) {
          break;
        }
      }
    }

    if (!startNode || !endNode) {
      return null;
    }

    try {
      const range = document.createRange();
      range.setStart(startNode, Math.max(0, Math.min(startNodeOffset, startNode.nodeValue.length)));
      range.setEnd(endNode, Math.max(0, Math.min(endNodeOffset, endNode.nodeValue.length)));
      return range;
    } catch {
      return null;
    }
  }

  /**
   * Reconstructs the exact DOM Range inside containerEl for a saved bookmark.
   */
  function resolveBookmarkRange(bookmark, containerEl) {
    if (!containerEl || !bookmark) {
      return {
        status: 'not_found',
        reason: 'Original response message could not be located in this conversation.'
      };
    }

    const textMap = buildResponseTextMap(containerEl);
    if (!textMap.normText) {
      return {
        status: 'not_found',
        reason: 'The assistant response is empty or still rendering.'
      };
    }

    const currentFingerprint = computeFingerprint(textMap.normText);
    const fingerprintMatches = bookmark.responseFingerprint === currentFingerprint;

    const targetNorm = (
      bookmark.normalizedText ||
      normalizeWhitespace(bookmark.selectedText)
    ).trim();

    if (!targetNorm) {
      return {
        status: 'not_found',
        reason: 'Bookmark passage text is empty.'
      };
    }

    const candidates = [];
    let searchFrom = 0;
    while (searchFrom <= textMap.normText.length - targetNorm.length) {
      const idx = textMap.normText.indexOf(targetNorm, searchFrom);
      if (idx === -1) break;
      candidates.push({
        normStart: idx,
        normEnd: idx + targetNorm.length
      });
      searchFrom = idx + 1;
    }

    // Fallback for selections across custom [data-d-block] / [data-d-text-flow] boundaries
    // where browser Selection.toString() inserted spaces/newlines between adjacent block text nodes
    if (candidates.length === 0) {
      const strippedTarget = targetNorm.replace(/\s+/g, '');
      if (strippedTarget.length >= 3) {
        const nonWsIndices = [];
        let strippedSource = '';
        for (let i = 0; i < textMap.normText.length; i++) {
          if (textMap.normText[i] !== ' ') {
            nonWsIndices.push(i);
            strippedSource += textMap.normText[i];
          }
        }
        let sPos = 0;
        while (sPos <= strippedSource.length - strippedTarget.length) {
          const foundIdx = strippedSource.indexOf(strippedTarget, sPos);
          if (foundIdx === -1) break;
          const normStart = nonWsIndices[foundIdx];
          const normEnd = nonWsIndices[foundIdx + strippedTarget.length - 1] + 1;
          candidates.push({ normStart, normEnd });
          sPos = foundIdx + 1;
        }
      }
    }

    if (candidates.length === 0) {
      return {
        status: 'changed',
        reason: fingerprintMatches
          ? 'Could not locate the exact bookmarked passage in this response.'
          : 'This response was edited or regenerated and no longer contains the bookmarked passage.'
      };
    }

    let bestCandidate = null;
    let bestScore = -1;

    for (const cand of candidates) {
      const actualPrefix = textMap.normText.slice(
        Math.max(0, cand.normStart - CONTEXT_RADIUS),
        cand.normStart
      );
      const actualSuffix = textMap.normText.slice(
        cand.normEnd,
        Math.min(textMap.normText.length, cand.normEnd + CONTEXT_RADIUS)
      );

      const prefixSim = scorePrefixSimilarity(bookmark.prefixContext || '', actualPrefix);
      const suffixSim = scoreSuffixSimilarity(bookmark.suffixContext || '', actualSuffix);
      const offsetDelta = Math.abs(cand.normStart - (bookmark.startOffset || 0));
      const offsetSim = 1 / (1 + offsetDelta / 120);

      const totalScore = prefixSim * 0.45 + suffixSim * 0.45 + offsetSim * 0.1;

      if (totalScore > bestScore) {
        bestScore = totalScore;
        bestCandidate = {
          ...cand,
          prefixSim,
          suffixSim,
          offsetSim,
          totalScore
        };
      }
    }

    if (!fingerprintMatches && bestCandidate) {
      const contextConfidence = (bestCandidate.prefixSim + bestCandidate.suffixSim) / 2;
      if (contextConfidence < 0.35 && targetNorm.length < 30) {
        return {
          status: 'changed',
          reason: 'This response has changed and the surrounding context no longer matches.'
        };
      }
    }

    const rawStart = textMap.normToRawStart[bestCandidate.normStart] ?? 0;
    const lastNormIdx = Math.max(0, bestCandidate.normEnd - 1);
    const rawEnd = textMap.normToRawEnd[lastNormIdx] ?? textMap.rawText.length;

    const range = createRangeFromRawOffsets(rawStart, rawEnd, textMap);
    if (!range) {
      return {
        status: 'not_found',
        reason: 'Could not reconstruct the DOM Range for the bookmarked passage.'
      };
    }

    return {
      status: 'resolved',
      range,
      fingerprintChanged: !fingerprintMatches,
      confidence: bestScore
    };
  }

  window.CGPTBookmarkerAnchorEngine = {
    computeFingerprint,
    buildResponseTextMap,
    createBookmarkAnchor,
    resolveBookmarkRange
  };
})();
