'use strict';
// Executado também com Node 12.4.0, no formato de sandbox usado pelo TizenBrew.
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const EventEmitter = require('events');
const builtin = require('module').builtinModules;
const handlers = [];
const network = Object.assign({}, require('http'), {
  createServer: function (handler) {
    handlers.push(handler);
    const server = new EventEmitter();
    server.listen = function () { return server; };
    server.close = function () {};
    return server;
  }
});
const fakeTls = Object.assign({}, require('tls'), {
  connect: function () {
    const socket = new EventEmitter();
    socket.destroy = function () {};
    socket.write = function () {};
    return socket;
  }
});
const timers = [];
const fakeFs = Object.assign({}, fs, {
  // Nada do teste grava no filesystem da TV ou liga autostart.
  writeFileSync: function () { throw new Error('read-only smoke'); }
});
const context = {
  require: function (name) {
    if (name === 'http') return network;
    if (name === 'tls') return fakeTls;
    if (name === 'fs') return fakeFs;
    if (builtin.indexOf(name) >= 0) return require(name);
    throw new Error('Dependência não incluída no bundle: ' + name);
  },
  module: { exports: {} },
  Buffer: Buffer,
  console: console,
  process: {
    version: process.version, versions: process.versions, arch: process.arch, platform: process.platform,
    env: {}, nextTick: process.nextTick.bind(process), memoryUsage: process.memoryUsage.bind(process),
    on: function () {}
  },
  setTimeout: function () { timers.push(1); return timers.length; },
  clearTimeout: function () {},
  setInterval: function () { return 1; }, clearInterval: function () {},
  setImmediate: setImmediate, clearImmediate: clearImmediate,
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../remote/tv-service.js'), 'utf8'), context, { timeout: 5000 });
assert.strictEqual(handlers.length, 2, 'remote e addon server iniciam');
function request(url, remote, origin) {
  let result;
  const res = { writeHead: function (code) { this.code = code; }, end: function (data) { result = { code: this.code, body: JSON.parse(String(data)) }; } };
  handlers[0]({ url: url, method: 'GET', headers: origin ? { origin: origin } : {}, socket: { remoteAddress: remote || '127.0.0.1' } }, res);
  return result;
}
const status = request('/api/torrent/status');
assert.strictEqual(status.code, 200);
assert.strictEqual(status.body.supported, true);
assert.strictEqual(status.body.available, true);
assert.strictEqual(status.body.active, false);
assert.strictEqual(request('/api/torrent/status', '192.168.1.4').code, 403);
assert.strictEqual(request('/api/torrent/status', '127.0.0.1', 'https://example.org').code, 403);
assert.strictEqual(request('/api/version').body.version, 12);
const memory = request('/api/memory');
assert.strictEqual(memory.code, 200);
assert.ok(memory.body.processRssMB > 0);
console.log('Serviço autocontido no sandbox: OK (' + process.version + ')');
