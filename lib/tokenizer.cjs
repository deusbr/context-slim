'use strict';

/**
 * Fast deterministic token estimator calibrated for code, JSON, logs, and prose.
 * Avoids external tokenizer binaries while staying within ~5-10% of BPE counts.
 */
function estimateTokens(text) {
  if (!text) return 0;
  const str = String(text);
  const len = str.length;
  if (len === 0) return 0;

  // Count structural punctuation/whitespace vs word tokens
  const words = str.match(/[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g);
  if (!words) return Math.ceil(len / 4);

  // Long identifiers/numbers split into ~4-char subwords in BPE
  let subwords = 0;
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (w.length <= 4) {
      subwords += 1;
    } else {
      subwords += Math.ceil(w.length / 4);
    }
  }
  const byChars = Math.ceil(len / 3.8);
  return Math.max(1, Math.round((subwords + byChars) / 2));
}

function computeSavings(beforeText, afterText) {
  const beforeStr = String(beforeText || '');
  const afterStr = String(afterText || '');
  const beforeTokens = estimateTokens(beforeStr);
  const afterTokens = estimateTokens(afterStr);
  const savedTokens = Math.max(0, beforeTokens - afterTokens);
  const savedPercent = beforeTokens > 0
    ? Number(((savedTokens / beforeTokens) * 100).toFixed(1))
    : 0;

  return {
    beforeChars: beforeStr.length,
    afterChars: afterStr.length,
    beforeLines: beforeStr ? beforeStr.split(/\r?\n/).length : 0,
    afterLines: afterStr ? afterStr.split(/\r?\n/).length : 0,
    beforeTokens,
    afterTokens,
    savedTokens,
    savedPercent
  };
}

module.exports = {
  estimateTokens,
  computeSavings
};
