// Owns the hardware controller instances (Push, MPC, APC, generic keyboard)
// and picks whichever one matches the currently-selected MIDI input port
// by name. main.js talks to this one object instead of branching on device
// type.
//
// Devices are tried in order; first `matches(name)` hit wins. The generic
// keyboard matches anything, so it must be last.

import { PushController } from './push.js';
import { MPCController } from './akai-mpc.js';
import { APCController } from './akai-apc.js';
import { KeyboardDevice } from './keyboard.js';

export class MidiRouter {
  constructor() {
    this.push = new PushController();
    this.mpc = new MPCController();
    this.apc = new APCController();
    this.keyboard = new KeyboardDevice();
    this.devices = [this.mpc, this.apc, this.push, this.keyboard];
    this.active = null;
  }

  setCCHandler(fn) {
    for (const d of this.devices) d.onCC = fn;
  }

  // Pick and attach a device. `inputs` is only used by KeyboardDevice
  // to build a closure over `inputs._kbdMidiBase`; the other devices
  // ignore it.
  // Returns { label, padMapper } or null if nothing to attach.
  attach(midiAccess, input, inputs) {
    if (!midiAccess || !input) return null;
    const name = input.name || '';
    const dev = this.devices.find(d => d.constructor.matches(name));
    dev.attach(midiAccess, input, inputs);
    this.active = dev;
    return {
      label: `Mapper: ${dev.constructor.label} — ${name}`,
      padMapper: dev.padMapper,
    };
  }

  detach() {
    for (const d of this.devices) d.detach();
    this.active = null;
  }

  handleCC(cc, val) {
    if (this.active) this.active.handleCC(cc, val);
    else this.push.handleCC(cc, val);
  }

  setScale(scaleName) {
    for (const d of this.devices) d.setScale(scaleName);
  }
}
