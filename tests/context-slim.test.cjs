'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');

const {
  estimateTokens,
  compressContent,
  compressPath,
  auditPath,
  getClientTargets,
  installClients,
  checkStatus
} = require('../index.cjs');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'context-slim-test-'));
}

test('compressContent shrinks JSON blobs/arrays and strips code comments safely', () => {
  const bigJson = JSON.stringify({
    meta: { service: 'orders' },
    image: 'data:image/png;base64,' + 'A'.repeat(500),
    items: Array.from({ length: 20 }, (_, i) => ({ id: i, name: `item-${i}`, payload: 'x'.repeat(100) }))
  }, null, 2);

  const jsonRes = compressContent(bigJson, { format: 'json', level: 'balanced', mode: 'standalone' });
  assert.equal(jsonRes.format, 'json');
  assert.ok(jsonRes.stats.savedPercent > 60, `Expected >60% savings, got ${jsonRes.stats.savedPercent}%`);
  assert.match(jsonRes.content, /<encoded-blob:/);
  assert.match(jsonRes.content, /more items omitted/);

  const verboseCode = `
    // Leading comment that wastes tokens
    /* Multi-line
       explanatory block */
    export async function fetchOrders(userId) {
      const url = "https://example.com/api"; // trailing note


      return fetch(url + "/" + userId);
    }
  `;
  const codeRes = compressContent(verboseCode, { format: 'code', level: 'balanced', mode: 'standalone' });
  assert.doesNotMatch(codeRes.content, /Leading comment/);
  assert.doesNotMatch(codeRes.content, /Multi-line/);
  assert.match(codeRes.content, /https:\/\/example\.com\/api/);
  assert.ok(codeRes.stats.afterTokens < codeRes.stats.beforeTokens);
});

test('compressContent collapses repeated log lines and preserves errors + context', () => {
  const lines = [];
  for (let i = 0; i < 40; i += 1) {
    lines.push(`\x1b[32m2026-11-20T10:00:${String(i).padStart(2, '0')}Z [INFO] Heartbeat ok\x1b[0m`);
  }
  for (let i = 0; i < 35; i += 1) {
    lines.push(`2026-11-20T10:01:${String(i).padStart(2, '0')}Z [INFO] Polling worker ${i}`);
  }
  lines.push('2026-11-20T10:02:00Z [ERROR] Database connection refused at 127.0.0.1:5432');
  for (let i = 0; i < 35; i += 1) {
    lines.push(`2026-11-20T10:03:${String(i).padStart(2, '0')}Z [INFO] Retry scheduled ${i}`);
  }

  const res = compressContent(lines.join('\n'), { format: 'log', level: 'balanced', mode: 'standalone' });
  assert.doesNotMatch(res.content, /\x1b\[/);
  assert.match(res.content, /\[repeated 40x\]/);
  assert.match(res.content, /Database connection refused/);
  assert.ok(res.stats.savedPercent > 35);
});

test('maxTokens bounds the final payload and preserves Unicode at truncation boundaries', () => {
  const input = 'START ' + '😀 !? é漢 '.repeat(200) + ' END';
  for (const maxTokens of [1, 2, 5, 10, 30, 100]) {
    const result = compressContent(input, { format: 'text', maxTokens });
    assert.ok(result.content.length > 0);
    assert.ok(estimateTokens(result.content) <= maxTokens, `Exceeded budget ${maxTokens}`);
    assert.equal(result.content, Buffer.from(result.content, 'utf8').toString('utf8'));
    assert.equal(result.stats.afterTokens, estimateTokens(result.content));
  }
  const result = compressContent(input, { format: 'text', maxTokens: 30 });
  assert.match(result.content, /^START .*\n…\n.* END$/s);
  assert.equal(compressContent('START', { format: 'text', maxTokens: 5 }).content, 'START');
});

test('compressPath and auditPath pack directories, ignore node_modules, and respect maxTokens', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'junk.js'), 'console.log("ignore");\n'.repeat(20));
    fs.writeFileSync(path.join(dir, 'app.js'), '// header\nexport function run(x) {\n  return x * 2;\n}\n'.repeat(15));
    fs.writeFileSync(path.join(dir, 'notes.md'), '# Notes\n\n<!-- hidden -->\nLine A\n\n\nLine B\n');

    const audit = auditPath(dir, { level: 'balanced' });
    assert.equal(audit.fileCount, 2);
    assert.ok(audit.stats.beforeTokens >= audit.stats.afterTokens);

    const packed = compressPath(dir, { level: 'balanced', mode: 'standalone', maxTokens: 90 });
    assert.equal(packed.fileCount, 2);
    assert.doesNotMatch(packed.content, /junk\.js/);
    assert.ok(estimateTokens(packed.content) <= 90);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI executes inspect and text compression cleanly', () => {
  const dir = makeTempDir();
  try {
    const filePath = path.join(dir, 'sample.json');
    fs.writeFileSync(filePath, JSON.stringify({ a: 1, b: [1, 2, 3, 4, 5, 6, 7] }, null, 2));
    const cli = path.resolve(__dirname, '../bin/context-slim.cjs');

    const out = execFileSync(process.execPath, [cli, 'inspect', filePath, '--json'], { encoding: 'utf8' });
    const parsed = JSON.parse(out);
    assert.equal(parsed.format, 'json');

    const textOut = execFileSync(process.execPath, [cli, 'text', '--text', '{"k":"v","arr":[1,2,3,4,5,6]}', '--json'], { encoding: 'utf8' });
    const textParsed = JSON.parse(textOut);
    assert.equal(textParsed.format, 'json');
    assert.match(textParsed.content, /more items omitted/);

    const input = 'alpha beta gamma '.repeat(100);
    const budgeted = execFileSync(process.execPath, [cli, 'text', '--max-tokens', '1', '--json'], {
      input, encoding: 'utf8'
    });
    assert.ok(JSON.parse(budgeted).stats.afterTokens <= 1);
    for (const budget of [[], ['-1'], ['1.5'], ['Infinity'], ['invalid']]) {
      assert.throws(
        () => execFileSync(process.execPath, [cli, 'text', '--max-tokens', ...budget], {
          input, stdio: ['pipe', 'pipe', 'pipe']
        }),
        /--max-tokens requires a non-negative integer/
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ultra-lean stdio MCP server serves <= 3 tools with low schema overhead', async () => {
  const dir = makeTempDir();
  try {
    const samplePath = path.join(dir, 'demo.js');
    fs.writeFileSync(samplePath, '// comment\nfunction hello() { return "world"; }\n'.repeat(100));

    const child = spawn(process.execPath, [path.resolve(__dirname, '../bin/mcp-server.cjs')], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const responses = [];
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('MCP timeout')), 4000);
      let buf = '';
      child.stdout.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() || '';
        for (const l of lines) {
          if (!l.trim()) continue;
          responses.push(JSON.parse(l));
          if (responses.length === 4) {
            clearTimeout(timer);
            resolve();
          }
        }
      });

      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'slim_audit', arguments: { path: samplePath } }
      }) + '\n');
      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'slim_file', arguments: { path: samplePath, maxTokens: 50 } }
      }) + '\n');
    });

    child.kill();
    assert.equal(responses[0].result.serverInfo.name, 'context-slim');
    assert.equal(responses[1].result.tools.length, 3);
    assert.ok(estimateTokens(JSON.stringify(responses[1].result.tools)) < 400);
    const auditRes = JSON.parse(responses[2].result.content[0].text);
    assert.equal(auditRes.format, 'code');
    const slimRes = JSON.parse(responses[3].result.content[0].text);
    assert.doesNotMatch(slimRes.content, /\/\/ comment/);
    assert.ok(slimRes.stats.afterTokens <= 50);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('installClients writes Codex TOML, Gemini JSON, Claude JSON, and portable SKILL.md safely', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    const appdata = path.join(dir, 'appdata');
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "gpt-5"\n');

    const targets = getClientTargets({ home, appdata, platform: 'win32' });
    const installed = installClients({ targets, installSharedWrapper: false });
    assert.ok(installed.some((r) => r.id === 'codex' && !r.skipped));

    const status = checkStatus(targets);
    assert.equal(status.find((s) => s.id === 'codex').mcpConfigured, true);
    assert.equal(status.find((s) => s.id === 'gemini').mcpConfigured, true);
    assert.equal(status.find((s) => s.id === 'claude-code').mcpConfigured, true);
    assert.equal(status.find((s) => s.id === 'codex').skillInstalled, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
