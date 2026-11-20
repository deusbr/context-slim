'use strict';

const { estimateTokens, computeSavings } = require('./lib/tokenizer.cjs');
const { detectExternalEngines } = require('./lib/adapters.cjs');
const {
  detectFormat,
  compressContent,
  compressDirectory,
  compressPath,
  auditPath
} = require('./lib/compressors.cjs');
const { getClientTargets, installClients, checkStatus } = require('./lib/installers.cjs');

module.exports = {
  estimateTokens,
  computeSavings,
  detectExternalEngines,
  detectFormat,
  compressContent,
  compressDirectory,
  compressPath,
  auditPath,
  getClientTargets,
  installClients,
  checkStatus
};
