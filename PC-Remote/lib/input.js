'use strict';

const { spawn } = require('child_process');
const { ensureHelper } = require('./native-helper');

/** Turns a control command object into one helper protocol line. */
function toLine(cmd) {
  switch (cmd.type) {
    case 'move':
      return `move\t${Math.round(cmd.dx || 0)}\t${Math.round(cmd.dy || 0)}`;
    case 'down':
      return `down\t${cmd.button || 'left'}`;
    case 'up':
      return `up\t${cmd.button || 'left'}`;
    case 'click':
      return `click\t${cmd.button || 'left'}`;
    case 'scroll':
      return `scroll\t${Math.round(cmd.delta || 0)}\t${Math.round(cmd.deltaX || 0)}`;
    case 'keydown':
    case 'keyup':
    case 'key':
      return `${cmd.type}\t${Math.round(cmd.vk || 0)}`;
    case 'text':
      return `text\t${String(cmd.text || '').replace(/[\r\n\t]+/g, ' ').slice(0, 512)}`;
    case 'ping':
      return 'ping';
    case 'probe':
      return 'probe';
    default:
      return null;
  }
}

/** Wraps the persistent native input injector. */
class InputController {
  constructor(log) {
    this.log = log || (() => {});
    this.proc = null;
    this.closing = false;
    this.onPos = null; // (x, y) => void, from a 'probe' reply
    this.onBlocked = null; // (message) => void, when Windows ignores injected input
    this.sendFailures = 0;
  }

  start() {
    if (this.proc) return;
    let exe;
    try {
      exe = ensureHelper(this.log);
    } catch (err) {
      this.log(`input helper unavailable: ${err.message}`);
      return;
    }
    this.proc = spawn(exe, ['input'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    this.proc.stdout.on('data', (d) => {
      for (const line of d.toString().split('\n')) {
        const text = line.trim();
        if (!text) continue;
        const pos = text.match(/^pos\t(-?\d+)\t(-?\d+)$/);
        if (pos && this.onPos) {
          this.onPos(Number(pos[1]), Number(pos[2]));
        } else {
          this.log(`[input] ${text}`);
        }
      }
    });
    this.proc.stderr.on('data', (d) => {
      for (const line of d.toString().split('\n')) {
        const text = line.trim();
        if (!text) continue;
        this.log(`[input:err] ${text}`);
        if (/^input blocked/.test(text) && this.onBlocked) this.onBlocked(text);
      }
    });
    this.proc.on('error', (err) => this.log(`input helper error: ${err.message}`));
    this.proc.on('exit', (code) => {
      this.proc = null;
      if (!this.closing) {
        this.log(`input injector exited (${code}), restarting`);
        setTimeout(() => this.start(), 1000);
      }
    });
  }

  send(cmd) {
    const line = toLine(cmd);
    if (!line) return false;
    if (!this.proc || !this.proc.stdin.writable) {
      this.start();
      if (!this.proc || !this.proc.stdin.writable) {
        this.noteFailure('input helper is not running');
        return false;
      }
    }
    try {
      this.proc.stdin.write(`${line}\n`);
      return true;
    } catch (err) {
      this.noteFailure(err.message);
      return false;
    }
  }

  /** Surface send failures without spamming the console at 30 messages/second. */
  noteFailure(reason) {
    this.sendFailures++;
    if (this.sendFailures === 1 || this.sendFailures % 300 === 0) {
      this.log(`[input:err] could not send input (${reason})`);
      if (this.onBlocked) this.onBlocked(`input failed: ${reason}`);
    }
  }

  stop() {
    this.closing = true;
    if (this.proc) {
      try {
        this.proc.stdin.end();
      } catch {
        /* ignore */
      }
      this.proc.kill();
      this.proc = null;
    }
  }
}

module.exports = { InputController, toLine };
