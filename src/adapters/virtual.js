import { LampAdapter } from './base.js';

/**
 * A lamp made of software. Use it to run the whole system before any hardware
 * shows up, and to demo the lock/unlock behaviour to your friends.
 *
 * Options:
 *   startOn  boolean  initial relay state (default false)
 *
 * `pressButton()` simulates someone pressing the physical button on the plug,
 * which is what `POST /api/virtual-button` calls.
 */
export class VirtualAdapter extends LampAdapter {
  async start() {
    this.on = Boolean(this.options.startOn);
    this.report({ online: true, on: this.on, source: 'init' });
    this.log.info('virtual lamp online');
  }

  async stop() {
    this.report({ online: false });
  }

  async set(on) {
    if (this.options.failEveryCommand) {
      throw new Error('virtual lamp configured to fail');
    }
    this.on = on;
    // Mimic a real device: the state report comes back asynchronously, tagged
    // as our own echo.
    setTimeout(() => this.report({ on, source: 'self' }), 20);
  }

  /** Simulates a human pressing the button on the plug. */
  pressButton() {
    this.on = !this.on;
    this.report({ on: this.on, source: 'local' });
    return this.on;
  }
}
