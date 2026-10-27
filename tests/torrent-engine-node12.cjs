'use strict';
// Run the same real-peer cases under Node 12, optionally in an isolated bundled VM.
var fs = require('fs');
var path = require('path');
var Module = require('module');
var vm = require('vm');
var assert = require('assert').strict;
var jobs = [];
var originalLoad = Module._load;
var factory = null;
if (!fs.rmSync) fs.rmSync = function remove(p) {
  if (!fs.existsSync(p)) return;
  if (!fs.statSync(p).isDirectory()) return fs.unlinkSync(p);
  fs.readdirSync(p).forEach(function (child) { remove(path.join(p, child)); }); fs.rmdirSync(p);
};
if (process.env.SERA_ENGINE_BUNDLE) {
  var ctx = { module: { exports: {} }, require: function (name) {
    if (Module.builtinModules.indexOf(name) >= 0) return require(name);
    throw new Error('Unbundled runtime dependency: ' + name);
  }, process: process, Buffer: Buffer, console: console, setTimeout: setTimeout, clearTimeout: clearTimeout,
  setInterval: setInterval, clearInterval: clearInterval, setImmediate: setImmediate, clearImmediate: clearImmediate };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(process.env.SERA_ENGINE_BUNDLE, 'utf8'), ctx, { timeout: 5000 });
  factory = ctx.module.exports;
}
Module._load = function (name, parent, isMain) {
  if (name === 'node:test') return function (label, options, run) { jobs.push({ label: label, run: typeof options === 'function' ? options : run }); };
  if (name === 'node:assert/strict') return assert;
  if (name === '../remote/torrent-engine.cjs' && factory) return factory;
  if (name.indexOf('node:') === 0) name = name.slice(5);
  return originalLoad.call(this, name, parent, isMain);
};
require('./torrent-engine.test.cjs');
Module._load = originalLoad;
(async function () {
  for (var i = 0; i < jobs.length; i++) {
    var cleanup = [];
    try {
      await jobs[i].run({ after: function (fn) { cleanup.push(fn); } });
      console.log('PASS ' + jobs[i].label);
    } finally { for (var j = cleanup.length - 1; j >= 0; j--) await cleanup[j](); }
  }
  console.log('Real torrent engine verified on ' + process.version + (factory ? ' in isolated bundle VM' : ''));
})().catch(function (error) { console.error(error); process.exitCode = 1; });
