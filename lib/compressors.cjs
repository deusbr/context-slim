'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { estimateTokens, computeSavings } = require('./tokenizer.cjs');
const { tryRepomixDirectory, tryRtkJsonKeys } = require('./adapters.cjs');

const CODE_EXTENSIONS = new Set([
  '.js', '.cjs', '.mjs', '.jsx', '.ts', '.tsx', '.py', '.go', '.rs', '.java',
  '.kt', '.cs', '.c', '.h', '.cpp', '.hpp', '.rb', '.php', '.swift', '.ps1', '.sh', '.sql', '.yaml', '.yml', '.toml'
]);
const LOG_EXTENSIONS = new Set(['.log', '.out', '.err']);
const MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx']);
const CSV_EXTENSIONS = new Set(['.csv', '.tsv']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'coverage', '__pycache__', '.venv', 'venv', 'target', 'out']);
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.svg', '.pdf', '.zip', '.tar', '.gz', '.7z',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.wasm', '.mp3', '.mp4', '.wav', '.ttf', '.woff', '.woff2', '.db', '.sqlite'
]);

function detectFormat(text, filePath) {
  if (filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.json') return 'json';
    if (ext === '.jsonl' || ext === '.ndjson') return 'jsonl';
    if (LOG_EXTENSIONS.has(ext)) return 'log';
    if (CSV_EXTENSIONS.has(ext)) return 'csv';
    if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown';
    if (CODE_EXTENSIONS.has(ext)) return 'code';
  }

  const trimmed = String(text || '').trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      JSON.parse(trimmed);
      return 'json';
    } catch {}
  }

  const lines = trimmed.split(/\r?\n/).slice(0, 20);
  const logHits = lines.filter((l) => /^\d{4}-\d{2}-\d{2}|\[(INFO|WARN|ERROR|DEBUG)\]|\b(ERROR|WARN|Exception|Traceback|at\s+\S+\s*\()/i.test(l)).length;
  if (logHits >= 3) return 'log';

  const codeHits = lines.filter((l) => /^\s*(import |export |const |let |var |function |class |def |async |from |package |using )/.test(l)).length;
  if (codeHits >= 2) return 'code';

  const mdHits = lines.filter((l) => /^\s*(#{1,6}\s|[-*]\s|\|\s.*\s\||```)/.test(l)).length;
  if (mdHits >= 3) return 'markdown';

  return 'text';
}

function summarizeJsonValue(val, level, depth = 0) {
  if (val === null || typeof val === 'number' || typeof val === 'boolean') return val;
  if (typeof val === 'string') {
    const maxLen = level === 'aggressive' ? 120 : level === 'balanced' ? 280 : 600;
    if ((/^data:image\/[a-z0-9.+-]+;base64,/i.test(val) || /^[A-Za-z0-9+/]{80,}={0,2}$/.test(val.slice(0, 120))) && val.length > 160) {
      return `<encoded-blob:${val.length} chars>`;
    }
    if (val.length > maxLen) {
      return `${val.slice(0, maxLen)}...<+${val.length - maxLen} chars>`;
    }
    return val;
  }
  if (Array.isArray(val)) {
    if (val.length === 0) return [];
    const maxItems = level === 'aggressive' ? 2 : level === 'balanced' ? 3 : 8;
    if (val.length <= maxItems) {
      return val.map((item) => summarizeJsonValue(item, level, depth + 1));
    }
    const head = val.slice(0, maxItems).map((item) => summarizeJsonValue(item, level, depth + 1));
    head.push(`<... ${val.length - maxItems} more items omitted (total=${val.length})>`);
    return head;
  }
  if (typeof val === 'object') {
    if (depth > (level === 'aggressive' ? 4 : 7)) {
      return `<object keys=${Object.keys(val).length}>`;
    }
    const out = {};
    const keys = Object.keys(val);
    const maxKeys = level === 'aggressive' ? 25 : level === 'balanced' ? 50 : 120;
    for (const k of keys.slice(0, maxKeys)) {
      out[k] = summarizeJsonValue(val[k], level, depth + 1);
    }
    if (keys.length > maxKeys) {
      out.__omittedKeys = `${keys.length - maxKeys} more keys`;
    }
    return out;
  }
  return val;
}

function compressJson(text, level, filePath, mode) {
  if (level === 'aggressive' && filePath && mode !== 'standalone') {
    const rtkOut = tryRtkJsonKeys(filePath);
    if (rtkOut) {
      return { content: rtkOut, engine: 'rtk-json' };
    }
  }
  try {
    const parsed = JSON.parse(text);
    const summarized = level === 'light' ? parsed : summarizeJsonValue(parsed, level);
    const compact = JSON.stringify(summarized);
    return { content: compact, engine: 'builtin-json' };
  } catch {
    return compressText(text, level);
  }
}

function compressJsonl(text, level) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  const maxLines = level === 'aggressive' ? 5 : level === 'balanced' ? 12 : 40;
  const sample = lines.slice(0, maxLines).map((l) => {
    try {
      return JSON.stringify(summarizeJsonValue(JSON.parse(l), level));
    } catch {
      return l.trim();
    }
  });
  if (lines.length > maxLines) {
    sample.push(`/* ... ${lines.length - maxLines} more JSONL records omitted (total=${lines.length}) */`);
  }
  return { content: sample.join('\n'), engine: 'builtin-jsonl' };
}

function stripCommentsFromCode(source, level) {
  // Preserve string literals while stripping /* */ and // or # comments
  let out = '';
  let i = 0;
  const n = source.length;
  let quote = null;

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    if (quote) {
      out += ch;
      if (ch === '\\' && i + 1 < n) {
        out += source[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }

    if (ch === '\'' || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      const keepJsDoc = level === 'light' && source[i + 2] === '*';
      const end = source.indexOf('*/', i + 2);
      if (end === -1) break;
      if (keepJsDoc) {
        out += source.slice(i, end + 2);
      }
      i = end + 2;
      continue;
    }

    if (ch === '/' && next === '/') {
      const nl = source.indexOf('\n', i + 2);
      if (nl === -1) break;
      i = nl;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

function extractCodeSkeleton(source) {
  const lines = source.split(/\r?\n/);
  const kept = [];
  const sigRegex = /^\s*(export\s+|async\s+|public\s+|private\s+|protected\s+|static\s+|function\s+|class\s+|interface\s+|type\s+|enum\s+|def\s+|fn\s+|func\s+|const\s+\w+\s*=\s*(async\s+)?\(|module\.exports)/;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^\s*(import\s+|from\s+\S+\s+import|const\s+\{?[\w,\s]+\}?\s*=\s*require\()/.test(line)) {
      kept.push(trimmed);
      continue;
    }
    if (sigRegex.test(line)) {
      kept.push(trimmed.endsWith('{') ? `${trimmed} ... }` : trimmed);
    }
  }
  return kept.length >= 3 ? kept.join('\n') : lines.map((l) => l.trimEnd()).filter(Boolean).join('\n');
}

function compressCode(text, level) {
  let cleaned = stripCommentsFromCode(String(text || ''), level);
  const lines = cleaned
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t]+$/g, ''));

  // Collapse consecutive blank lines
  const collapsed = [];
  let blankRun = 0;
  for (const line of lines) {
    if (!line.trim()) {
      blankRun += 1;
      if (blankRun <= (level === 'light' ? 1 : 0)) {
        collapsed.push('');
      }
    } else {
      blankRun = 0;
      collapsed.push(level === 'aggressive' ? line.replace(/^\s+/, (m) => (m.length > 2 ? '  ' : m)) : line);
    }
  }

  const compact = collapsed.join('\n');
  if (level === 'aggressive' && lines.length > 40) {
    return { content: extractCodeSkeleton(compact), engine: 'builtin-code-skeleton' };
  }
  return { content: compact, engine: 'builtin-code' };
}

function compressLog(text, level) {
  // Strip ANSI escape sequences
  const noAnsi = String(text || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const lines = noAnsi.split(/\r?\n/);

  const normalizeForDedup = (line) =>
    line
      .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, '<TS>')
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<UUID>')
      .replace(/\b0x[0-9a-f]+\b/gi, '<HEX>')
      .trim();

  const deduped = [];
  let prevNorm = null;
  let prevRaw = '';
  let repeatCount = 0;

  for (const raw of lines) {
    const trimmed = raw.trimEnd();
    if (!trimmed.trim()) continue;
    const norm = normalizeForDedup(trimmed);
    if (norm === prevNorm) {
      repeatCount += 1;
    } else {
      if (repeatCount > 0) {
        deduped.push(`${prevRaw} [repeated ${repeatCount + 1}x]`);
        repeatCount = 0;
      } else if (prevNorm !== null) {
        deduped.push(prevRaw);
      }
      prevNorm = norm;
      prevRaw = trimmed;
    }
  }
  if (prevNorm !== null) {
    deduped.push(repeatCount > 0 ? `${prevRaw} [repeated ${repeatCount + 1}x]` : prevRaw);
  }

  if (level === 'light' || deduped.length <= 60) {
    return { content: deduped.join('\n'), engine: 'builtin-log' };
  }

  // Keep errors/warnings + context + head/tail
  const keepIdx = new Set();
  const headCount = level === 'aggressive' ? 5 : 10;
  const tailCount = level === 'aggressive' ? 10 : 20;
  for (let i = 0; i < Math.min(headCount, deduped.length); i += 1) keepIdx.add(i);
  for (let i = Math.max(0, deduped.length - tailCount); i < deduped.length; i += 1) keepIdx.add(i);

  const radius = level === 'aggressive' ? 1 : 2;
  for (let i = 0; i < deduped.length; i += 1) {
    if (/\b(error|err|fatal|exception|traceback|fail|failed|warn|warning|panic)\b/i.test(deduped[i])) {
      for (let j = Math.max(0, i - radius); j <= Math.min(deduped.length - 1, i + radius); j += 1) {
        keepIdx.add(j);
      }
    }
  }

  const out = [];
  let skipping = 0;
  for (let i = 0; i < deduped.length; i += 1) {
    if (keepIdx.has(i)) {
      if (skipping > 0) {
        out.push(`... [${skipping} non-error log lines omitted] ...`);
        skipping = 0;
      }
      out.push(deduped[i]);
    } else {
      skipping += 1;
    }
  }
  if (skipping > 0) {
    out.push(`... [${skipping} non-error log lines omitted] ...`);
  }

  return { content: out.join('\n'), engine: 'builtin-log-errors' };
}

function compressCsv(text, level) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length <= 15) return { content: lines.join('\n'), engine: 'builtin-csv' };
  const head = level === 'aggressive' ? 5 : level === 'balanced' ? 10 : 25;
  const tail = level === 'aggressive' ? 2 : 5;
  if (lines.length <= head + tail + 1) return { content: lines.join('\n'), engine: 'builtin-csv' };

  const out = [
    ...lines.slice(0, head),
    `# ... ${lines.length - head - tail} rows omitted (total=${lines.length - 1} data rows) ...`,
    ...lines.slice(lines.length - tail)
  ];
  return { content: out.join('\n'), engine: 'builtin-csv' };
}

function compressMarkdown(text, level) {
  let out = String(text || '').replace(/<!--[\s\S]*?-->/g, '');
  const lines = out.split(/\r?\n/).map((l) => l.replace(/[ \t]+$/g, ''));
  const kept = [];
  let blankRun = 0;
  for (const line of lines) {
    if (level === 'aggressive' && /^([-*_])\1{2,}$/.test(line.trim())) continue;
    if (!line.trim()) {
      blankRun += 1;
      if (blankRun <= 1) kept.push('');
    } else {
      blankRun = 0;
      kept.push(line);
    }
  }
  return { content: kept.join('\n').trim(), engine: 'builtin-markdown' };
}

function compressText(text, level) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/[ \t]+$/g, '').replace(/[ \t]{2,}/g, ' '));
  const kept = [];
  const seenLong = new Set();
  let blankRun = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      blankRun += 1;
      if (blankRun <= (level === 'aggressive' ? 0 : 1)) kept.push('');
      continue;
    }
    blankRun = 0;
    if (level !== 'light' && trimmed.length > 40) {
      if (seenLong.has(trimmed)) continue;
      seenLong.add(trimmed);
    }
    kept.push(line);
  }
  return { content: kept.join('\n').trim(), engine: 'builtin-text' };
}

function enforceMaxTokens(content, maxTokens) {
  if (!maxTokens || maxTokens <= 0) return content;
  const current = estimateTokens(content);
  if (current <= maxTokens) return content;
  const ratio = maxTokens / current;
  const targetChars = Math.max(120, Math.floor(content.length * ratio * 0.92));
  const headChars = Math.floor(targetChars * 0.72);
  const tailChars = Math.floor(targetChars * 0.25);
  return `${content.slice(0, headChars).trimEnd()}\n\n...[truncated to fit maxTokens=${maxTokens}; omitted ~${content.length - headChars - tailChars} chars]...\n\n${content.slice(content.length - tailChars).trimStart()}`;
}

function compressContent(input, options = {}) {
  const level = ['light', 'balanced', 'aggressive'].includes(options.level) ? options.level : 'balanced';
  const mode = ['auto', 'hybrid', 'standalone'].includes(options.mode) ? options.mode : 'auto';
  const format = options.format && options.format !== 'auto'
    ? options.format
    : detectFormat(input, options.filePath);

  let result;
  if (format === 'json') result = compressJson(input, level, options.filePath, mode);
  else if (format === 'jsonl') result = compressJsonl(input, level);
  else if (format === 'code') result = compressCode(input, level);
  else if (format === 'log') result = compressLog(input, level);
  else if (format === 'csv') result = compressCsv(input, level);
  else if (format === 'markdown') result = compressMarkdown(input, level);
  else result = compressText(input, level);

  const finalContent = enforceMaxTokens(result.content, options.maxTokens);
  const stats = computeSavings(input, finalContent);

  return {
    format,
    level,
    engine: result.engine,
    content: finalContent,
    stats
  };
}

function collectFilesRecursive(rootDir, maxFiles = 200) {
  const results = [];
  function walk(dir) {
    if (results.length >= maxFiles) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) continue;
        const stat = fs.statSync(fullPath);
        if (stat.size > 1024 * 1024) continue;
        results.push(fullPath);
      }
    }
  }
  walk(rootDir);
  return results;
}

function compressDirectory(dirPath, options = {}) {
  const level = ['light', 'balanced', 'aggressive'].includes(options.level) ? options.level : 'balanced';
  const mode = ['auto', 'hybrid', 'standalone'].includes(options.mode) ? options.mode : 'auto';
  const files = collectFilesRecursive(dirPath, options.maxFiles || 120);

  let rawTotal = '';
  for (const file of files) {
    try {
      rawTotal += `\n// ${path.relative(dirPath, file)}\n${fs.readFileSync(file, 'utf8')}`;
    } catch {}
  }

  if (mode !== 'standalone') {
    const repomixOut = tryRepomixDirectory(dirPath);
    if (repomixOut) {
      const trimmed = enforceMaxTokens(repomixOut, options.maxTokens);
      return {
        target: dirPath,
        type: 'directory',
        fileCount: files.length,
        engine: 'repomix-ast',
        level,
        content: trimmed,
        stats: computeSavings(rawTotal, trimmed)
      };
    }
  }

  const chunks = [`# Context Pack: ${path.basename(dirPath)} (${files.length} files, level=${level})`];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const rel = path.relative(dirPath, file).replace(/\\/g, '/');
      const res = compressContent(raw, { level, mode: 'standalone', filePath: file });
      chunks.push(`\n## ${rel} [${res.format}; ${res.stats.beforeTokens}->${res.stats.afterTokens} tok]\n${res.content}`);
    } catch {}
  }

  const packed = enforceMaxTokens(chunks.join('\n'), options.maxTokens);
  return {
    target: dirPath,
    type: 'directory',
    fileCount: files.length,
    engine: 'builtin-directory',
    level,
    content: packed,
    stats: computeSavings(rawTotal, packed)
  };
}

function compressPath(targetPath, options = {}) {
  const resolved = path.resolve(targetPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Path not found: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    return compressDirectory(resolved, options);
  }
  const raw = fs.readFileSync(resolved, 'utf8');
  const res = compressContent(raw, { ...options, filePath: resolved });
  return {
    target: resolved,
    type: 'file',
    fileCount: 1,
    ...res
  };
}

function auditPath(targetPath, options = {}) {
  const resolved = path.resolve(targetPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Path not found: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (stat.isFile()) {
    const raw = fs.readFileSync(resolved, 'utf8');
    const res = compressContent(raw, { ...options, filePath: resolved, mode: 'standalone' });
    return {
      target: resolved,
      type: 'file',
      format: res.format,
      fileCount: 1,
      stats: res.stats
    };
  }

  const files = collectFilesRecursive(resolved, options.maxFiles || 120);
  let beforeTokens = 0;
  let afterTokens = 0;
  const breakdown = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const res = compressContent(raw, { ...options, filePath: file, mode: 'standalone' });
      beforeTokens += res.stats.beforeTokens;
      afterTokens += res.stats.afterTokens;
      breakdown.push({
        file: path.relative(resolved, file).replace(/\\/g, '/'),
        format: res.format,
        beforeTokens: res.stats.beforeTokens,
        afterTokens: res.stats.afterTokens,
        savedPercent: res.stats.savedPercent
      });
    } catch {}
  }
  breakdown.sort((a, b) => b.beforeTokens - a.beforeTokens);
  const savedTokens = Math.max(0, beforeTokens - afterTokens);
  return {
    target: resolved,
    type: 'directory',
    fileCount: files.length,
    stats: {
      beforeTokens,
      afterTokens,
      savedTokens,
      savedPercent: beforeTokens > 0 ? Number(((savedTokens / beforeTokens) * 100).toFixed(1)) : 0
    },
    topFiles: breakdown.slice(0, 10)
  };
}

module.exports = {
  detectFormat,
  compressContent,
  compressDirectory,
  compressPath,
  auditPath
};
