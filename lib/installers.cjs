'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SKILL_SOURCE = path.resolve(__dirname, '../skill/SKILL.md');
const MCP_SERVER_PATH = path.resolve(__dirname, '../bin/mcp-server.cjs');
const CLI_PATH = path.resolve(__dirname, '../bin/context-slim.cjs');

function getClientTargets(opts = {}) {
  const home = opts.home || os.homedir();
  const appdata = opts.appdata || process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const platform = opts.platform || process.platform;

  const claudeDesktopConfig = platform === 'win32'
    ? path.join(appdata, 'Claude', 'claude_desktop_config.json')
    : platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : path.join(home, '.config', 'Claude', 'claude_desktop_config.json');

  return [
    {
      id: 'codex',
      name: 'Codex',
      format: 'toml',
      configPath: path.join(home, '.codex', 'config.toml'),
      skillPaths: [
        path.join(home, '.agents', 'skills', 'context-slim', 'SKILL.md'),
        path.join(home, '.codex', 'skills', 'context-slim', 'SKILL.md')
      ]
    },
    {
      id: 'gemini',
      name: 'Gemini CLI',
      format: 'json',
      configPath: path.join(home, '.gemini', 'settings.json'),
      skillPaths: [path.join(home, '.gemini', 'skills', 'context-slim', 'SKILL.md')]
    },
    {
      id: 'claude-code',
      name: 'Claude Code',
      format: 'json',
      configPath: path.join(home, '.claude.json'),
      skillPaths: [path.join(home, '.claude', 'skills', 'context-slim', 'SKILL.md')]
    },
    {
      id: 'claude-desktop',
      name: 'Claude Desktop',
      format: 'json',
      configPath: claudeDesktopConfig,
      skillPaths: []
    },
    {
      id: 'cursor',
      name: 'Cursor',
      format: 'json',
      configPath: path.join(home, '.cursor', 'mcp.json'),
      skillPaths: []
    }
  ];
}

function writeAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

function upsertJsonMcp(configPath, serverName, entry) {
  let obj = {};
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf8').trim();
    if (raw) obj = JSON.parse(raw);
  }
  if (!obj.mcpServers || typeof obj.mcpServers !== 'object') {
    obj.mcpServers = {};
  }
  obj.mcpServers[serverName] = entry;
  writeAtomic(configPath, JSON.stringify(obj, null, 2) + '\n');
}

function escapeTomlString(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function upsertTomlMcp(configPath, serverName, entry) {
  const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  const header = `[mcp_servers.${serverName}]`;
  const block = [
    header,
    `command = "${escapeTomlString(entry.command)}"`,
    `args = [${entry.args.map((a) => `"${escapeTomlString(a)}"`).join(', ')}]`,
    'enabled = true',
    ''
  ].join('\n');

  const lines = existing ? existing.split(/\r?\n/) : [];
  const out = [];
  let skipping = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      if (trimmed === header || trimmed.startsWith(`[mcp_servers.${serverName}.`)) {
        skipping = true;
        continue;
      }
      skipping = false;
    }
    if (!skipping) out.push(line);
  }

  const base = out.join('\n').trimEnd();
  const next = base ? `${base}\n\n${block}` : block;
  writeAtomic(configPath, next);
}

function installClients(options = {}) {
  const targets = options.targets || getClientTargets(options);
  const selected = options.clients && options.clients.length && !options.clients.includes('all')
    ? targets.filter((t) => options.clients.includes(t.id))
    : targets;

  const entry = {
    command: options.nodePath || process.execPath,
    args: [MCP_SERVER_PATH]
  };
  const skillText = fs.existsSync(SKILL_SOURCE) ? fs.readFileSync(SKILL_SOURCE, 'utf8') : '';
  const results = [];

  for (const target of selected) {
    const exists = fs.existsSync(target.configPath) || fs.existsSync(path.dirname(target.configPath));
    if (!exists && !options.forceCreate && (target.id === 'claude-desktop' || target.id === 'cursor')) {
      results.push({ id: target.id, name: target.name, skipped: true, reason: 'Client directory not found' });
      continue;
    }

    if (target.format === 'toml') {
      upsertTomlMcp(target.configPath, 'context-slim', entry);
    } else {
      upsertJsonMcp(target.configPath, 'context-slim', entry);
    }

    let skillsWritten = 0;
    if (skillText) {
      for (const sp of target.skillPaths) {
        writeAtomic(sp, skillText);
        skillsWritten += 1;
      }
    }

    results.push({
      id: target.id,
      name: target.name,
      skipped: false,
      configPath: target.configPath,
      skillsWritten
    });
  }

  if (options.installSharedWrapper !== false && process.platform === 'win32') {
    const home = options.home || os.homedir();
    const wrapperDir = path.join(home, 'OpenBot', 'Shared', 'Tools', 'bin');
    if (fs.existsSync(wrapperDir) || options.forceWrapper) {
      const wrapperPath = path.join(wrapperDir, 'context-slim.cmd');
      const cmdContent = `@echo off\r\n"${entry.command}" "${CLI_PATH}" %*\r\n`;
      writeAtomic(wrapperPath, cmdContent);
      results.push({ id: 'shared-path', name: 'Windows PATH Wrapper', skipped: false, configPath: wrapperPath });
    }
  }

  return results;
}

function checkStatus(targets = getClientTargets()) {
  return targets.map((t) => {
    let mcpConfigured = false;
    if (fs.existsSync(t.configPath)) {
      const raw = fs.readFileSync(t.configPath, 'utf8');
      if (t.format === 'toml') {
        mcpConfigured = raw.includes('[mcp_servers.context-slim]');
      } else {
        try {
          const parsed = JSON.parse(raw);
          mcpConfigured = Boolean(parsed.mcpServers && parsed.mcpServers['context-slim']);
        } catch {}
      }
    }
    const skillInstalled = t.skillPaths.length > 0 && t.skillPaths.every((p) => fs.existsSync(p));
    return {
      id: t.id,
      name: t.name,
      configExists: fs.existsSync(t.configPath),
      mcpConfigured,
      skillInstalled
    };
  });
}

module.exports = {
  getClientTargets,
  installClients,
  checkStatus
};
