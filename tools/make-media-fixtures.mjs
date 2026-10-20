// Reproducible, synthetic local fixtures; no downloaded copyrighted media.
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, openSync, writeSync, ftruncateSync, closeSync } from 'node:fs';
const directory = new URL('../web/media/generated/', import.meta.url);
mkdirSync(directory, { recursive: true });
for (const [name, codec] of [['clip.mp4', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-movflags', '+faststart', '-c:a', 'aac']], ['clip.webm', ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus']]]) {
  const target = new URL(name, directory);
  if (existsSync(target)) continue;
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '12', ...codec, '-y', target.pathname], { stdio: 'inherit' });
}
// A valid MP4 free atom makes this fixture >64MiB while keeping the movie
// short. A gateway that downloads whole files cannot pass the byte-budget gate.
const { copyFileSync, statSync } = await import('node:fs');
const large = new URL('large.mp4', directory);
copyFileSync(new URL('clip.mp4', directory), large);
const offset = statSync(large).size, padding = 72 * 1024 * 1024;
const fd = openSync(large, 'r+');
const header = Buffer.alloc(8); header.writeUInt32BE(padding); header.write('free', 4);
writeSync(fd, header, 0, 8, offset); ftruncateSync(fd, offset + padding); closeSync(fd);
console.log('Created synthetic MP4, WebM and >64MiB range fixture.');
const fragmented = new URL('fragmented.mp4', directory);
if (!existsSync(fragmented)) execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', new URL('clip.mp4', directory).pathname, '-c', 'copy', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-y', fragmented.pathname], { stdio: 'inherit' });
// Unmodified third-party player, used only to test MSE compatibility in JSC.
copyFileSync(new URL('../node_modules/hls.js/dist/hls.min.js', import.meta.url), new URL('hls.min.js', directory));
copyFileSync(new URL('../node_modules/hls.js/LICENSE', import.meta.url), new URL('hls-LICENSE.txt', directory));
const hls = new URL('hls/', directory); mkdirSync(hls, { recursive: true });
if (!existsSync(new URL('index.m3u8', hls))) execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', new URL('clip.mp4', directory).pathname, '-c', 'copy', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_filename', new URL('segment-%03d.ts', hls).pathname, '-y', new URL('index.m3u8', hls).pathname], { stdio: 'inherit' });
