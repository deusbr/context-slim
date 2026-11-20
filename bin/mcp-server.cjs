#!/usr/bin/env node
'use strict';

const readline = require('node:readline');
const pkg = require('../package.json');
const { compressContent, compressPath, auditPath } = require('../index.cjs');

// Ultra-lean schema definitions (<= 3 tools) to avoid MCP Schema Bloat
const TOOLS = [
  {
    name: 'slim_audit',
    description: 'Estimate token size and savings for a file or folder.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        level: { type: 'string', enum: ['light', 'balanced', 'aggressive'] }
      },
      required: ['path'],
      additionalProperties: false
    }
  },
  {
    name: 'slim_file',
    description: 'Compress a file or folder before reading to save tokens.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        level: { type: 'string', enum: ['light', 'balanced', 'aggressive'] },
        maxTokens: { type: 'integer', minimum: 50 }
      },
      required: ['path'],
      additionalProperties: false
    }
  },
  {
    name: 'slim_text',
    description: 'Compress raw text, logs, JSON, or code snippets.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string' },
        format: { type: 'string', enum: ['auto', 'code', 'json', 'log', 'csv', 'markdown', 'text'] },
        level: { type: 'string', enum: ['light', 'balanced', 'aggressive'] },
        maxTokens: { type: 'integer', minimum: 50 }
      },
      required: ['content'],
      additionalProperties: false
    }
  }
];

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

function handleToolCall(name, args) {
  if (name === 'slim_audit') {
    return auditPath(args.path, { level: args.level });
  }
  if (name === 'slim_file') {
    return compressPath(args.path, { level: args.level, maxTokens: args.maxTokens });
  }
  if (name === 'slim_text') {
    return compressContent(args.content, { format: args.format, level: args.level, maxTokens: args.maxTokens });
  }
  throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32601 });
}

function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.method === 'initialize') {
    return respond(msg.id, {
      protocolVersion: '2024-11-05',
      serverInfo: { name: 'context-slim', version: pkg.version },
      capabilities: { tools: {} }
    });
  }
  if (msg.method === 'notifications/initialized') return;
  if (msg.method === 'tools/list') {
    return respond(msg.id, { tools: TOOLS });
  }
  if (msg.method === 'tools/call') {
    const { name, arguments: args = {} } = msg.params || {};
    try {
      const payload = handleToolCall(name, args);
      return respond(msg.id, {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }]
      });
    } catch (err) {
      return respond(msg.id, {
        isError: true,
        content: [{ type: 'text', text: err.message }]
      });
    }
  }
  if (msg.id !== undefined) {
    respondError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    handleMessage(JSON.parse(trimmed));
  } catch (err) {
    respondError(null, -32700, `Parse error: ${err.message}`);
  }
});
