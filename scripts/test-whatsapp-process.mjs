import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { terminateChildProcess } from '../server/whatsappProcess.js';

class FakeChild extends EventEmitter {
  constructor({ stubborn = false, exited = false } = {}) {
    super();
    this.exitCode = exited ? 0 : null;
    this.stubborn = stubborn;
    this.signals = [];
  }

  kill(signal) {
    this.signals.push(signal);
    if (!this.stubborn || signal === 'SIGKILL') {
      setTimeout(() => {
        this.exitCode = 0;
        this.emit('exit', 0, signal);
      }, 5);
    }
    return true;
  }
}

const graceful = new FakeChild();
assert.deepEqual(
  await terminateChildProcess(graceful, { gracefulTimeoutMs: 50, forcedTimeoutMs: 50 }),
  { exited: true, forced: false }
);
assert.deepEqual(graceful.signals, ['SIGTERM']);

const stubborn = new FakeChild({ stubborn: true });
assert.deepEqual(
  await terminateChildProcess(stubborn, { gracefulTimeoutMs: 20, forcedTimeoutMs: 50 }),
  { exited: true, forced: true }
);
assert.deepEqual(stubborn.signals, ['SIGTERM', 'SIGKILL']);

const stopped = new FakeChild({ exited: true });
assert.deepEqual(await terminateChildProcess(stopped), { exited: true, forced: false });
assert.deepEqual(stopped.signals, []);

console.log('WhatsApp: encerramento normal e forçado do worker validados.');
