'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

function findCandidatePaths(binName) {
  const candidates = [];
  const home = os.homedir();
  const sharedBin = path.join(home, 'OpenBot', 'Shared', 'Tools', 'bin');
  const sharedRoot = path.join(home, 'OpenBot', 'Shared', 'Tools');

  if (process.platform === 'win32') {
    if (binName === 'rtk') {
      candidates.push(path.join(sharedRoot, 'rtk', 'rtk.exe'));
      candidates.push(path.join(sharedBin, 'rtk.cmd'));
    } else if (binName === 'repomix') {
      candidates.push(path.join(sharedRoot, 'node-token-tools', 'node_modules', 'repomix', 'bin', 'repomix.cjs'));
      candidates.push(path.join(sharedBin, 'repomix.cmd'));
    }
  }

  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    if (process.platform === 'win32') {
      candidates.push(path.join(dir, `${binName}.exe`));
      candidates.push(path.join(dir, `${binName}.cmd`));
    } else {
      candidates.push(path.join(dir, binName));
    }
  }
  return candidates;
}

function resolveExecutable(binName) {
  for (const candidate of findCandidatePaths(binName)) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function detectExternalEngines() {
  const rtk = resolveExecutable('rtk');
  const repomix = resolveExecutable('repomix');
  return {
    standalone: { available: true, description: 'Built-in zero-dependency compressor' },
    rtk: { available: Boolean(rtk), path: rtk },
    repomix: { available: Boolean(repomix), path: repomix }
  };
}

function runExternalSafe(resolvedPath, args, timeoutMs = 15000) {
  if (!resolvedPath) return null;
  try {
    if (resolvedPath.endsWith('.cjs') || resolvedPath.endsWith('.js') || resolvedPath.endsWith('.mjs')) {
      return execFileSync(process.execPath, [resolvedPath, ...args], {
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    }
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolvedPath)) {
      return execFileSync('cmd.exe', ['/d', '/s', '/c', resolvedPath, ...args], {
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    }
    return execFileSync(resolvedPath, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch {
    return null;
  }
}

function tryRepomixDirectory(dirPath) {
  const repomix = resolveExecutable('repomix');
  if (!repomix) return null;
  const out = runExternalSafe(repomix, ['--compress', '--style', 'markdown', '--stdout', dirPath], 20000);
  if (out && out.trim().length > 0) {
    return out.trim();
  }
  return null;
}

function tryRtkJsonKeys(filePath) {
  const rtk = resolveExecutable('rtk');
  if (!rtk) return null;
  const out = runExternalSafe(rtk, ['json', '--keys-only', filePath], 8000);
  if (out && out.trim().length > 0) {
    return out.trim();
  }
  return null;
}

module.exports = {
  detectExternalEngines,
  tryRepomixDirectory,
  tryRtkJsonKeys
};
