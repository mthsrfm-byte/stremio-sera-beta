'use strict';
// Bounded BEP9 metadata exchange; derived from torrent-stream@1.2.1 (MIT, see torrent-stream.cjs).
var bncode = require('bncode');
var crypto = require('crypto');
var BLOCK = 16384;
var MAX = 512 * 1024;
module.exports = function (engine, callback) {
  var completed = false;
  var allChunks = [];
  return function (wire) {
    if (!wire.peerExtensions.extended) return;
    var chunks = [];
    allChunks.push(chunks);
    var size = 0;
    var channel = 0;
    wire.on('extended', function (id, ext) {
      if (completed) return;
      try {
        if (id === 0) {
          var hello = bncode.decode(ext);
          if (!hello.m || !hello.m.ut_metadata || !Number.isInteger(hello.metadata_size) || hello.metadata_size <= 0 || hello.metadata_size > MAX) return;
          size = hello.metadata_size;
          channel = hello.m.ut_metadata;
          for (var n = 0; n < Math.ceil(size / BLOCK); n++) wire.extended(channel, { msg_type: 0, piece: n });
          return;
        }
        if (id !== 1 || !size || ext.length > BLOCK + 1024) return;
        var end = ext.toString('ascii', 0, Math.min(ext.length, 1024)).indexOf('ee');
        if (end < 0) return;
        var msg = bncode.decode(ext.slice(0, end + 2));
        if (msg.msg_type !== 1 || !Number.isInteger(msg.piece) || msg.piece < 0 || msg.piece >= Math.ceil(size / BLOCK)) return;
        var expected = Math.min(BLOCK, size - msg.piece * BLOCK);
        var data = ext.slice(end + 2);
        if (data.length !== expected) return;
        chunks[msg.piece] = data;
        for (var i = 0; i < Math.ceil(size / BLOCK); i++) if (!chunks[i]) return;
        var metadata = Buffer.concat(chunks, size);
        if (crypto.createHash('sha1').update(metadata).digest('hex') !== engine.infoHash) { chunks.length = 0; return; }
        completed = true;
        allChunks.forEach(function (list) { list.length = 0; });
        allChunks = [];
        callback(engine.metadata = metadata);
      } catch (err) { /* malformed peer metadata is ignored */ }
    });
    wire.on('close', function () { chunks.length = 0; var pos = allChunks.indexOf(chunks); if (pos >= 0) allChunks.splice(pos, 1); });
    wire.extended(0, { m: { ut_metadata: 1 } });
  };
};
