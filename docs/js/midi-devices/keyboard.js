// Generic MIDI keyboard: no LEDs, no display. Note N maps linearly to
// emitter index (N - mic._kbdMidiBase). This is the fallback when no
// specific controller (Push/MPC/APC) is matched — always matches last.

export class KeyboardDevice {
  static matches(_name) { return true; }
  static label = 'keyboard (linear)';
  constructor() {
    this.output = null;
    this.onCC = null;
    this.onAttach = null;
    this.padMapper = null;
  }
  attach(_midiAccess, _input, mic) {
    // padMapper depends on the current mic._kbdMidiBase, so build a
    // closure fresh on attach. The base itself is set by onAttach (the
    // app resyncs it from the current "Base" Hz selector).
    this.padMapper = (note) => {
      const base = mic._kbdMidiBase ?? 48;
      const idx = note - base;
      return (idx >= 0 && idx < 128) ? idx : -1;
    };
    if (this.onAttach) this.onAttach();
  }
  detach() {}
  handleCC() {}
  setScale() {}
}
