'use strict';

const { spawn } = require('child_process');
const { ensureHelper } = require('./native-helper');

/**
 * Streams screen frames from the native helper.
 * Emits 'frame' with a JPEG Buffer and 'dims' with the real screen size.
 * The capture process only runs while at least one viewer is connected.
 */
class ScreenStreamer {
  constructor(capture, log) {
    this.capture = capture || {};
    this.log = log || (() => {});
    this.proc = null;
    this.buffer = Buffer.alloc(0);
    this.viewers = 0;
    this.lastFrame = null;
    this.lastFrameAt = 0;
    this.dims = null;
    this.onFrame = () => {};
    this.onDims = () => {};
    this.closing = false;
  }

  setCapture(capture) {
    this.capture = { ...this.capture, ...capture };
  }

  addViewer() {
    this.viewers += 1;
    if (this.viewers === 1) this.start();
    return this.lastFrame;
  }

  removeViewer() {
    this.viewers = Math.max(0, this.viewers - 1);
    if (this.viewers === 0) {
      this.stopTimer = setTimeout(() => {
        if (this.viewers === 0) this.stop();
      }, 5000);
    }
  }

  start() {
    if (this.proc) return;
    if (this.stopTimer) clearTimeout(this.stopTimer);
    let exe;
    try {
      exe = ensureHelper(this.log);
    } catch (err) {
      this.log(`screen helper unavailable: ${err.message}`);
      return;
    }
    const c = this.capture || {};
    const args = ['screen', String(c.maxWidth || 1280), String(c.quality || 55), String(c.fps || 8)];
    this.proc = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.buffer = Buffer.alloc(0);

    this.proc.stdout.on('data', (chunk) => this.consume(chunk));
    this.proc.stderr.on('data', (d) => {
      const text = d.toString().trim();
      if (!text) return;
      for (const line of text.split(/\r?\n/)) {
        if (line.startsWith('{')) {
          try {
            this.dims = JSON.parse(line);
            this.onDims(this.dims);
            continue;
          } catch {
            /* fall through to logging */
          }
        }
        this.log(`[screen:err] ${line}`);
      }
    });
    this.proc.on('error', (err) => this.log(`screen helper error: ${err.message}`));
    this.proc.on('exit', (code) => {
      this.proc = null;
      if (!this.closing && this.viewers > 0) {
        this.log(`screen capture exited (${code}), restarting`);
        setTimeout(() => this.start(), 1500);
      }
    });
  }

  consume(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= 4) {
      const len = this.buffer.readInt32LE(0);
      if (len <= 0 || len > 20 * 1024 * 1024) {
        // Desynchronised: drop everything and wait for a clean frame.
        this.buffer = Buffer.alloc(0);
        return;
      }
      if (this.buffer.length < 4 + len) return;
      const frame = this.buffer.subarray(4, 4 + len);
      this.buffer = this.buffer.subarray(4 + len);
      this.lastFrame = Buffer.from(frame);
      this.lastFrameAt = Date.now();
      this.onFrame(this.lastFrame);
    }
  }

  stop() {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }

  shutdown() {
    this.closing = true;
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stop();
  }
}

module.exports = { ScreenStreamer };
