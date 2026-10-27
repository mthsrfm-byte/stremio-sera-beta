'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loaded = import('../src/js/lib/streammetadata.js');

test('seed metadata distinguishes unavailable, zero, grouped numbers and suffixes', async () => {
  const { parseMetadata: parse } = await loaded;
  for (const [title, expected] of [
    ['👤 0', 0], ['👤 1,234', 1234], ['Seeders: 1.234', 1234],
    ['Seeds: 2.5k', 2500], ['S: 2,5k', 2500], ['👤 1.2m', 1200000],
    ['👤 -1', null], ['👤 NaN', null], ['👤 1.2.3', null],
    ['Seeders: 12cats', null], ['Peers: 90 👥 80 Leechers: 50', null],
  ]) assert.equal(parse({ title }).seeders, expected, title);
  assert.equal(parse({ seeders: 7, behaviorHints: { seeders: 20 }, title: '👤 200' }).seeders, 7);
  assert.equal(parse({ seeders: -1, behaviorHints: { seeders: 0 }, title: '👤 200' }).seeders, 0);
  assert.equal(parse({ title: '1080p x264' }).seeders, null);
});

test('sizes prefer per-file structured bytes and respect decimal versus binary units', async () => {
  const { parseMetadata: parse } = await loaded;
  const mib = 1024 * 1024;
  const file = parse({ videoSize: 2 * mib, behaviorHints: { videoSize: 3 * mib }, title: 'Season 1 Complete 💾 90 GB' });
  assert.equal(file.sizeMb, 3);
  assert.equal(file.sizeScope, 'file');
  assert.equal(parse({ title: '💾 1 GiB' }).sizeMb, 1024);
  assert.equal(parse({ title: '💾 1 GB' }).sizeMb, 1e9 / mib);
  assert.equal(parse({ title: '💾 2,5 GB' }).sizeMb, 2.5e9 / mib);
  assert.equal(parse({ title: '💾 1,234 MiB' }).sizeMb, 1234);
  assert.equal(parse({ title: '💾 1.234 GB' }).sizeMb, 1.234e9 / mib);
  assert.equal(parse({ title: 'size unknown' }).sizeMb, 0);
  assert.equal(parse({ title: '💾 -1 GB' }).sizeMb, 0);
});

test('season packs cannot masquerade as per-episode sizes', async () => {
  const { parseMetadata: parse } = await loaded;
  for (const title of ['Show.S01.1080p 20 GB', 'Show.S01-S05.1080p 20 GB', 'Season pack 20 GB', 'Show Complete 20 GB']) {
    assert.equal(parse({ title }).sizeScope, 'pack', title);
  }
  assert.equal(parse({ title: 'Show.S01E02.1080p 1 GB' }).sizeScope, 'file');
  assert.equal(parse({ title: 'Show.S01.E02.1080p 1 GB' }).sizeScope, 'file');
  assert.equal(parse({ title: 'Show Season 1 Episode 2 1 GB' }).sizeScope, 'file');
  assert.equal(parse({ title: 'Movie Dual Audio MULTI 2 GB' }).sizeScope, 'file');
  assert.equal(parse({ title: 'episode', packSize: 4096 }).sizeScope, 'pack');
  assert.equal(parse({ title: 'Show.S01.Complete 20 GB', behaviorHints: { videoSize: 4096 } }).sizeScope, 'file');
});

test('filename takes precedence for video resolution and codec while preserving audio options', async () => {
  const { parseMetadata: parse } = await loaded;
  const info = parse({ name: 'Torrentio 4K H264', title: 'old title', behaviorHints: { filename: 'Show.S01E02.1080p.HEVC.DTS.AAC.mkv' } });
  assert.equal(info.res, '1080p');
  assert.equal(info.videoCodec, 'hevc');
  assert.deepEqual(info.audioCodecs, ['aac', 'dts']);
  assert.equal(info.file, 'Show.S01E02.1080p.HEVC.DTS.AAC.mkv');
  assert.equal(parse({ title: 'Movie AV1 TrueHD Atmos' }).videoCodec, 'av1');
  assert.deepEqual(parse({ title: 'Movie AV1 TrueHD Atmos' }).audioCodecs, ['truehd']);
  assert.deepEqual(parse({ title: 'Movie DDP5.1 AAC' }).audioCodecs, ['aac', 'eac3']);
  assert.deepEqual(parse({ title: 'Movie E-AC3' }).audioCodecs, ['eac3']);
  assert.deepEqual(parse({ title: 'Movie E-AC3 AC3' }).audioCodecs, ['eac3', 'ac3']);
  assert.deepEqual(parse({ title: 'Movie AAC', behaviorHints: { filename: 'Movie.1080p.mkv' } }).audioCodecs, ['aac']);
});

test('transport stream container is not a low quality resolution tag', async () => {
  const { parseMetadata: parse, resolution } = await loaded;
  assert.equal(resolution('Movie.ts'), '');
  assert.equal(resolution('Movie.1080p.ts'), '1080p');
  assert.equal(resolution('Movie.HDTS.x264'), 'SD');
  assert.equal(parse({ title: 'Movie.HDCAM.1080p' }).lowQuality, true);
  assert.equal(parse({ title: 'Movie.HDCAM.1080p' }).cam, true);
  assert.equal(parse({ title: 'Movie.sample.mp4 💾 100 MB' }).sample, true);
  assert.equal(parse({ title: 'Movie.sample.mp4 💾 1 GiB' }).sample, false);
  assert.equal(parse({ title: 'Movie.1080p.ts' }).lowQuality, false);
});

test('language flags and existing display metadata remain compatible', async () => {
  const { parseMetadata: parse } = await loaded;
  const stream = { name: 'Torrentio [RD+]', title: 'Movie.1080p.DUAL 🇧🇷 🇺🇸\n👤 32 💾 3 GiB' };
  const before = JSON.stringify(stream), info = parse(stream);
  assert.equal(info.dub, true);
  assert.equal(info.original, true);
  assert.equal(info.cached, true);
  assert.equal(info.addon, 'Torrentio');
  assert.equal(info.file, 'Movie.1080p.DUAL');
  assert.equal(JSON.stringify(stream), before);
});
