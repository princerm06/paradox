import { createServer } from 'node:http';
import { createReadStream, statSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = readFileSync(join(repo, '.primary-demo-output'), 'utf8').trim();
const require = createRequire(join(repo, 'apps/studio/package.json'));
const { chromium, expect } = require('@playwright/test');
const media = JSON.parse(readFileSync(join(output, 'media-verification.json'), 'utf8'));
const file = media.video;
const size = statSync(file).size;
const frames = join(output, 'review-frames');
mkdirSync(frames, { recursive: true });
const server = createServer((request, response) => {
  if (request.url === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }); return response.end('<!doctype html><html><body style="margin:0;background:#090e17"><video style="display:block;width:1600px;height:900px" preload="auto" src="/demo.mp4"></video></body></html>'); }
  if (request.url !== '/demo.mp4') { response.writeHead(404); return response.end(); }
  if (request.headers.range) {
    const [from, to] = request.headers.range.replace('bytes=', '').split('-');
    const start = Number(from);
    const end = to ? Math.min(Number(to), size - 1) : size - 1;
    response.writeHead(206, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    createReadStream(file, { start, end }).pipe(response);
  } else {
    response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    createReadStream(file).pipe(response);
  }
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const report = { file, bytes: size, frames: [] };
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => document.querySelector('video').readyState >= 2);
  Object.assign(report, await page.locator('video').evaluate(video => ({ duration: video.duration, width: video.videoWidth, height: video.videoHeight, h264Support: video.canPlayType('video/mp4; codecs="avc1.640028"') })));
  expect(report.width).toBe(1600);
  expect(report.height).toBe(900);
  expect(Math.abs(report.duration - media.duration_expected)).toBeLessThan(0.2);
  await page.locator('video').evaluate(video => video.play());
  await page.waitForTimeout(500);
  await page.locator('video').evaluate(video => video.pause());
  for (const scene of media.scenes) {
    for (const fraction of [0.35, 0.8]) {
      const second = scene.start + (scene.end - scene.start) * fraction;
      await page.locator('video').evaluate((video, target) => new Promise(resolveSeek => { video.addEventListener('seeked', resolveSeek, { once: true }); video.currentTime = target; }), second);
      await page.waitForTimeout(80);
      const image = join(frames, `${scene.id}-${fraction}.png`);
      await page.screenshot({ path: image });
      report.frames.push({ scene: scene.id, second, path: image });
    }
  }
  report.videoError = await page.locator('video').evaluate(video => video.error?.message ?? null);
  expect(report.videoError).toBeNull();
  report.passed = true;
  writeFileSync(join(output, 'playback-verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, frames: report.frames.length }, null, 2));
} finally {
  await browser.close();
  await new Promise(resolveClose => server.close(resolveClose));
}
