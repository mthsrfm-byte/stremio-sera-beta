'use strict';
// One ephemeral torrent, bounded verified-piece cache, no FFmpeg and no video files on disk.
var Readable = require('stream').Readable;
var parseUrl = require('url').parse;
var DEFAULT_TRACKERS = ['udp://tracker.opentrackr.org:1337/announce', 'udp://open.stealth.si:80/announce'];
var MiB = 1024 * 1024;

function reply(res, code, data) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}
function body(req, callback) {
  var text = '', done = false;
  function finish(err, value) { if (done) return; done = true; callback(err, value); }
  req.on('data', function (chunk) { if (done) return; text += chunk; if (text.length > 16384) finish(new Error('Pedido muito grande')); });
  req.on('end', function () { if (done) return; try { finish(null, JSON.parse(text || '{}')); } catch (e) { finish(new Error('JSON inválido')); } });
  req.on('error', function (e) { finish(e); });
}
// The old peer protocol has no frame bound and can throw on malformed messages.
function guardWire(wire) {
  var parse = wire._parse;
  var bad = false;
  function abort() {
    wire._parserSize = Number.MAX_SAFE_INTEGER;
    wire._parser = function () {};
    if (!bad) { bad = true; wire.destroy(); }
  }
  wire._parse = function (size, parser) {
    if (wire._finished && size === Number.MAX_VALUE) return parse.call(wire, size, parser);
    if (bad) return;
    if (!Number.isInteger(size) || size < 1 || size > 64 * 1024) return abort();
    return parse.call(wire, size, function (buffer) {
      try { parser(buffer); } catch (err) { abort(); }
    });
  };
}
function getRange(header, length) {
  if (!header) return { start: 0, end: length - 1, partial: false };
  var m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (!m[1] && !m[2])) return null;
  var start = m[1] ? Number(m[1]) : Math.max(0, length - Number(m[2]));
  var end = m[1] ? (m[2] ? Math.min(Number(m[2]), length - 1) : length - 1) : length - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= length || (!m[1] && Number(m[2]) === 0)) return null;
  return { start: start, end: end, partial: true };
}
function mime(name) {
  return /\.mp4$|\.m4v$/i.test(name) ? 'video/mp4' : /\.webm$/i.test(name) ? 'video/webm' : /\.ts$/i.test(name) ? 'video/mp2t' : 'video/x-matroska';
}
function chooseFile(files, request) {
  if (request.fileIdx !== undefined && request.fileIdx !== null) {
    var idx = Number(request.fileIdx);
    if (!Number.isInteger(idx) || idx < 0 || idx >= files.length || !files[idx].length) throw new Error('Índice do arquivo inválido');
    return idx;
  }
  var candidates = files.map(function (f, i) { return { file: f, index: i }; }).filter(function (f) { return /\.(mp4|mkv|webm|m4v|mov|ts|avi)$/i.test(f.file.name || f.file.path) && f.file.length > 0; });
  if (!candidates.length) throw new Error('Nenhum arquivo de vídeo encontrado');
  if (Number.isInteger(request.season) && Number.isInteger(request.episode)) {
    var episode = String(request.episode).padStart(2, '0');
    var re = new RegExp('(?:s0*' + request.season + '[ ._-]*e0*' + request.episode + '(?!\\d)|(?:^|[^0-9])' + request.season + 'x' + episode + '(?!\\d))', 'i');
    var matching = candidates.filter(function (f) { return re.test(f.file.name || f.file.path); });
    if (matching.length) candidates = matching;
    else if (candidates.length > 1) throw new Error('Não foi possível identificar este episódio no torrent');
  }
  candidates.sort(function (a, b) {
    var sa = /\bsample\b/i.test(a.file.name) ? 1 : 0, sb = /\bsample\b/i.test(b.file.name) ? 1 : 0;
    return sa - sb || b.file.length - a.file.length;
  });
  return candidates[0].index;
}

// Store owns at most limit bytes. Evictions reset BOTH scheduler pieces and bitfield.
function boundedStore(limit, onEvict, report) {
  return function (pieceLength) {
    var chunks = new Map(), bytes = 0, closed = false;
    return {
      chunkLength: pieceLength,
      put: function (index, buffer, cb) {
        if (closed) { if (cb) process.nextTick(function () { cb(new Error('Cache encerrado')); }); return; }
        if (buffer.length > limit) { if (cb) process.nextTick(function () { cb(new Error('Peça maior que o cache')); }); return; }
        if (chunks.has(index)) { bytes -= chunks.get(index).length; chunks.delete(index); }
        while (bytes + buffer.length > limit && chunks.size) {
          var key = chunks.keys().next().value;
          bytes -= chunks.get(key).length;
          chunks.delete(key);
          onEvict(key);
        }
        chunks.set(index, buffer); bytes += buffer.length; report(bytes);
        if (cb) process.nextTick(function () { cb(null); });
      },
      get: function (index, opts, cb) {
        if (typeof opts === 'function') { cb = opts; opts = null; }
        var buffer = chunks.get(index);
        if (buffer) { chunks.delete(index); chunks.set(index, buffer); }
        process.nextTick(function () {
          if (!buffer || closed) return cb(new Error('Peça ausente do cache'));
          var start = opts && opts.offset || 0;
          cb(null, opts ? buffer.slice(start, opts.length ? start + opts.length : undefined) : buffer);
        });
      },
      close: function (cb) { closed = true; chunks.clear(); bytes = 0; report(0); if (cb) process.nextTick(cb); },
      destroy: function (cb) { this.close(cb); }
    };
  };
}

module.exports = function createTorrentService(options) {
  var opts = options || {};
  var base = opts.basePath || '/api/torrent';
  var cacheLimit = opts.cacheBytes || 8 * MiB;
  var idleMs = opts.idleMs || 10 * 60 * 1000;
  var metadataMs = opts.metadataTimeout || 60000;
  var pieceMs = opts.pieceTimeout || 45000;
  var supported = Number(process.versions.node.split('.')[0]) >= 12;
  var current = null, lastError = '', closed = false;
  var cancelledIds = new Map();
  var timer = setInterval(function () {
    if (current && Date.now() - current.touched > idleMs) stop(current.id);
  }, Math.min(idleMs, 30000));
  if (timer.unref) timer.unref();

  function status() {
    var s = current, engine = s && s.engine;
    return { supported: supported, available: supported && !closed, active: !!s, state: s ? s.state : 'idle',
      sessionId: s && s.id || null, peers: engine && engine.swarm ? engine.swarm.wires.length : 0,
      downloaded: engine && engine.swarm ? engine.swarm.downloaded : 0,
      speed: engine && engine.swarm && engine.swarm.downloadSpeed ? Math.round(engine.swarm.downloadSpeed()) : 0,
      partialBytes: engine && engine.partialBytes ? engine.partialBytes() : 0, cacheBytes: s && s.cacheBytes || 0, cacheLimit: cacheLimit, processRssMB: Math.round(process.memoryUsage().rss / MiB),
      file: s && s.file ? s.file.name : null, error: lastError || null };
  }
  function rememberCancel(id) {
    cancelledIds.set(id, Date.now());
    if (cancelledIds.size > 64) cancelledIds.delete(cancelledIds.keys().next().value);
  }
  function stop(id) {
    if (id) rememberCancel(id);
    var s = current;
    if (!s || (id && s.id !== id)) return false;
    current = null;
    clearTimeout(s.metadataTimer);
    if (s.respond) { var cb = s.respond; s.respond = null; cb(new Error('Torrent cancelado')); }
    if (s.stream) s.stream.destroy();
    if (s.response && !s.response.writableEnded) s.response.destroy();
    s.waits.slice().forEach(function (cancel) { cancel(new Error('Torrent cancelado')); });
    s.waits = [];
    if (s.engine) { try { s.engine.destroy(); } catch (e) {} }
    s.cacheBytes = 0;
    return true;
  }
  function fail(s, error) {
    lastError = String(error && error.message || error).slice(0, 200);
    stop(s.id);
  }
  function start(request, cb) {
    if (!supported || closed) return cb(new Error('Torrent local exige Node 12 ou mais recente'));
    if (!request || !/^[a-f0-9]{40}$/i.test(request.infoHash || '') || !/^[a-zA-Z0-9_-]{1,96}$/.test(request.sessionId || '')) return cb(new Error('Hash ou sessão inválidos'));
    if (cancelledIds.has(request.sessionId)) return cb(new Error('Torrent cancelado'));
    stop(); lastError = '';
    var s = current = { id: request.sessionId, engine: null, state: 'metadata', touched: Date.now(), cacheBytes: 0, waits: [], respond: cb };
    function ready(err, result) { if (!s.respond) return; var done = s.respond; s.respond = null; clearTimeout(s.metadataTimer); done(err, result); }
    s.metadataTimer = setTimeout(function () { fail(s, new Error('Tempo esgotado ao buscar metadados do torrent')); }, metadataMs);
    var sources = Array.isArray(request.sources) ? request.sources.slice(0, 16) : [];
    var trackers = sources.map(function (x) { return String(x).replace(/^tracker:/, ''); }).filter(function (x) { return /^(udp|https?):\/\//.test(x) && x.length < 512; });
    if (!trackers.length) trackers = DEFAULT_TRACKERS;
    var link = 'magnet:?xt=urn:btih:' + request.infoHash.toLowerCase() + trackers.map(function (tr) { return '&tr=' + encodeURIComponent(tr); }).join('');
    var make = opts.engineFactory || require('./torrent-stream.cjs');
    var engineOptions = Object.assign({ connections: 12, uploads: 0, verify: false, persist: false, trackers: trackers, maxPieceLength: Math.min(cacheLimit, 4 * MiB), timeout: 20000,
      storage: boundedStore(cacheLimit, function (index) { if (s.engine && s.engine.forgetPiece) s.engine.forgetPiece(index); }, function (bytes) { s.cacheBytes = bytes; }) }, opts.engineOptions || {});
    try {
      s.engine = make(opts.torrentData || link, engineOptions);
      s.engine.on('wire', guardWire);
      s.engine.on('error', function (e) { if (current === s) fail(s, e); });
      s.engine.on('ready', function () {
        if (current !== s) return;
        try {
          s.fileIdx = chooseFile(s.engine.files, request);
          s.file = s.engine.files[s.fileIdx];
          s.engine.files.forEach(function (file) { file.deselect(); });
          s.state = 'ready'; s.touched = Date.now();
          ready(null, { sessionId: s.id, url: base + '/stream/' + s.id + '/' + s.fileIdx, name: s.file.name, length: s.file.length });
        } catch (e) { fail(s, e); }
      });
      // Discovery may announce thousands of addresses; cap queued candidates as well as sockets.
      var connect = s.engine.connect;
      s.engine.connect = function (address) {
        if (Object.keys(s.engine.swarm._peers || {}).length >= 96) return;
        return connect.call(s.engine, address);
      };
      if (opts.onEngine) opts.onEngine(s.engine);
    } catch (e) { fail(s, e); }
  }

  function ensurePiece(s, index, callback) {
    var engine = s.engine, done = false;
    var pieceTimer;
    function finish(err, buffer) {
      if (done) return; done = true;
      clearTimeout(pieceTimer);
      engine.removeListener('download', onDownload);
      engine.deselect(index, index, 1, notify);
      if (err && engine.forgetPiece && !engine.bitfield.get(index)) engine.forgetPiece(index, true);
      var pos = s.waits.indexOf(finish); if (pos >= 0) s.waits.splice(pos, 1);
      callback(err, buffer);
    }
    function read() { engine.store.get(index, function (err, buffer) { if (!err) finish(null, buffer); else if (current === s && !done) { engine.forgetPiece(index); engine.select(index, index, 1, notify); } }); }
    function notify() { if (!done && engine.bitfield.get(index)) read(); }
    function onDownload(which) { if (which === index) notify(); }
    s.waits.push(finish);
    pieceTimer = setTimeout(function () { finish(new Error('Torrent sem dados suficientes; tente outra fonte')); }, pieceMs);
    engine.on('download', onDownload);
    if (engine.bitfield.get(index)) read();
    else engine.select(index, index, 1, notify);
    return function () { finish(new Error('Leitura cancelada')); };
  }

  function stream(req, res, sessionId, fileIdx) {
    var s = current;
    if (!s || s.id !== sessionId || s.state !== 'ready' || String(s.fileIdx) !== fileIdx) return reply(res, 404, { error: 'Sessão de torrent encerrada' });
    var range = getRange(req.headers.range, s.file.length);
    if (!range) { res.writeHead(416, { 'Content-Range': 'bytes */' + s.file.length }); return res.end(); }
    s.touched = Date.now();
    var headers = { 'Content-Type': mime(s.file.name), 'Content-Length': range.end - range.start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length' };
    if (range.partial) headers['Content-Range'] = 'bytes ' + range.start + '-' + range.end + '/' + s.file.length;
    res.writeHead(range.partial ? 206 : 200, headers);
    if (req.method === 'HEAD') return res.end();
    // Samsung may open a new Range before closing the old one. Only one read stays active.
    if (s.stream) s.stream.destroy();
    if (s.response && s.response !== res && !s.response.writableEnded) s.response.destroy();
    s.response = res;
    var cursor = range.start, pending = false, cancelWait = null;
    var source = new Readable({ highWaterMark: 64 * 1024, read: function () {
      if (pending || source.destroyed) return;
      if (cursor > range.end) return source.push(null);
      pending = true;
      var absolute = s.file.offset + cursor, pieceLength = s.engine.torrent.pieceLength;
      var index = Math.floor(absolute / pieceLength), offset = absolute % pieceLength;
      cancelWait = ensurePiece(s, index, function (err, buffer) {
        pending = false; cancelWait = null;
        if (source.destroyed || current !== s) return;
        if (err) return source.destroy(err);
        var take = Math.min(buffer.length - offset, range.end - cursor + 1);
        cursor += take; s.touched = Date.now(); source.push(buffer.slice(offset, offset + take));
      });
    }, destroy: function (err, cb) { if (cancelWait) { var cancel = cancelWait; cancelWait = null; cancel(); } cb(err); } });
    s.stream = source;
    source.on('error', function (err) { lastError = err.message; res.destroy(); });
    res.on('close', function () { source.destroy(); if (s.stream === source) s.stream = null; if (s.response === res) s.response = null; });
    source.pipe(res);
  }

  function handle(req, res) {
    var pathname = parseUrl(req.url).pathname;
    if (pathname !== base && pathname.indexOf(base + '/') !== 0) return false;
    var address = req.socket && req.socket.remoteAddress;
    if (address && address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') { reply(res, 403, { error: 'Torrent disponível somente dentro da TV' }); return true; }
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Range' }); res.end(); return true; }
    if (pathname === base + '/status' && req.method === 'GET') { reply(res, 200, status()); return true; }
    if (pathname === base + '/start' && req.method === 'POST') {
      body(req, function (err, value) { if (err) return reply(res, 400, { error: err.message }); start(value, function (error, result) { reply(res, error ? 400 : 200, error ? { error: lastError || error.message } : result); }); }); return true;
    }
    if (pathname === base + '/stop' && req.method === 'POST') {
      body(req, function (err, value) { if (err || !value || !/^[a-zA-Z0-9_-]{1,96}$/.test(value.sessionId || '')) return reply(res, 400, { error: 'Sessão obrigatória' }); reply(res, 200, { stopped: stop(value.sessionId) }); }); return true;
    }
    var match = new RegExp('^' + base + '/stream/([a-zA-Z0-9_-]{1,96})/(\\d+)$').exec(pathname);
    if (match && (req.method === 'GET' || req.method === 'HEAD')) { stream(req, res, match[1], match[2]); return true; }
    reply(res, 404, { error: 'Rota de torrent inválida' }); return true;
  }
  return { handle: handle, stop: stop, status: status, close: function () { closed = true; clearInterval(timer); stop(); } };
};
module.exports.guardWire = guardWire;
module.exports.parseRange = getRange;
module.exports.boundedStore = boundedStore;
module.exports.chooseFile = chooseFile;
