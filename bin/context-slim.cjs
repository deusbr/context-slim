#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const pkg = require('../package.json');
const {
  compressContent,
  compressPath,
  auditPath,
  detectExternalEngines,
  installClients,
  checkStatus
} = require('../index.cjs');

function copyToClipboard(text) {
  if (process.platform === 'win32') {
    execFileSync('clip.exe', [], { input: text, encoding: 'utf8', windowsHide: true });
    return true;
  }
  if (process.platform === 'darwin') {
    execFileSync('pbcopy', [], { input: text, encoding: 'utf8' });
    return true;
  }
  try {
    execFileSync('xclip', ['-selection', 'clipboard'], { input: text, encoding: 'utf8' });
    return true;
  } catch {
    execFileSync('xsel', ['--clipboard', '--input'], { input: text, encoding: 'utf8' });
    return true;
  }
}

function parseFlags(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--') && ['level', 'mode', 'max-tokens', 'format', 'out', 'client', 'text'].includes(key)) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return { positionals, flags };
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (buf += c));
    process.stdin.on('end', () => resolve(buf));
  });
}

function printHelp() {
  console.log(`context-slim v${pkg.version} — Universal Token-Saving Compressor

Usage:
  context-slim pack <path...> [--level light|balanced|aggressive] [--mode auto|hybrid|standalone] [--max-tokens N] [--copy] [--out file] [--json]
  context-slim text [--text "..." | --stdin] [--format auto|code|json|log|csv|markdown|text] [--level ...] [--max-tokens N] [--copy] [--json]
  context-slim inspect <path...> [--level ...] [--json]
  context-slim engines [--json]
  context-slim install [--client all|codex|gemini|claude-code|claude-desktop|cursor]
  context-slim status [--json]`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }
  if (args.includes('--version') || args.includes('-v')) {
    console.log(pkg.version);
    return;
  }

  const cmd = args[0];
  const { positionals, flags } = parseFlags(args.slice(1));
  const level = flags.level || 'balanced';
  const mode = flags.mode || 'auto';
  const maxTokens = flags['max-tokens'] ? Number(flags['max-tokens']) : 0;

  if (cmd === 'engines') {
    const engines = detectExternalEngines();
    console.log(JSON.stringify(engines, null, 2));
    return;
  }

  if (cmd === 'status') {
    console.log(JSON.stringify(checkStatus(), null, 2));
    return;
  }

  if (cmd === 'install') {
    const clients = flags.client ? String(flags.client).split(',').map((s) => s.trim()) : ['all'];
    const res = installClients({ clients });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (cmd === 'inspect') {
    if (positionals.length === 0) throw new Error('Provide at least one file or directory path.');
    const audits = positionals.map((p) => auditPath(p, { level }));
    if (flags.json) {
      console.log(JSON.stringify(audits.length === 1 ? audits[0] : audits, null, 2));
      return;
    }
    for (const a of audits) {
      console.log(`${a.target} (${a.type}, files=${a.fileCount}): ${a.stats.beforeTokens} -> ${a.stats.afterTokens} tokens (saved ${a.stats.savedTokens}, ${a.stats.savedPercent}%)`);
      if (a.topFiles && a.topFiles.length) {
        for (const f of a.topFiles.slice(0, 5)) {
          console.log(`  - ${f.file}: ${f.beforeTokens} -> ${f.afterTokens} tok (-${f.savedPercent}%)`);
        }
      }
    }
    return;
  }

  if (cmd === 'text') {
    const raw = flags.text !== undefined ? String(flags.text) : await readStdin();
    if (!raw) throw new Error('Provide --text "..." or pipe text via stdin.');
    const res = compressContent(raw, { level, mode, maxTokens, format: flags.format || 'auto' });
    if (flags.copy) copyToClipboard(res.content);
    if (flags.out) fs.writeFileSync(flags.out, res.content, 'utf8');
    if (flags.json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      process.stdout.write(res.content + '\n');
      process.stderr.write(`[context-slim] ${res.format}/${res.engine}: ${res.stats.beforeTokens} -> ${res.stats.afterTokens} tokens (-${res.stats.savedPercent}%)\n`);
    }
    return;
  }

  if (cmd === 'pack') {
    if (positionals.length === 0) throw new Error('Provide at least one file or directory path.');
    const outputs = positionals.map((p) => compressPath(p, { level, mode, maxTokens }));
    const combinedContent = outputs.length === 1
      ? outputs[0].content
      : outputs.map((o) => `=== ${o.target} (${o.engine}) ===\n${o.content}`).join('\n\n');

    if (flags.copy) copyToClipboard(combinedContent);
    if (flags.out) fs.writeFileSync(flags.out, combinedContent, 'utf8');

    if (flags.json) {
      console.log(JSON.stringify(outputs.length === 1 ? outputs[0] : outputs, null, 2));
      return;
    }
    process.stdout.write(combinedContent + '\n');
    for (const o of outputs) {
      process.stderr.write(`[context-slim] ${o.target} (${o.engine}): ${o.stats.beforeTokens} -> ${o.stats.afterTokens} tokens (-${o.stats.savedPercent}%)\n`);
    }
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
