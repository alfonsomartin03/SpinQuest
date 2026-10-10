// Telling a double click of the Zwift Click from two single presses. Either button counts. The first press has already done
// its job by the time the second arrives (it shifted gear), so the caller says what to take back.

export const DOUBLE_CLICK_MS = 450;

export class DoubleClick {
  constructor(ms = DOUBLE_CLICK_MS) {
    this.ms = ms;
    this.last = null; // { t, undo }
  }

  /**
   * A press at time `now` (ms). Pass `armed` = whether a double click would mean anything right now. Returns
   * `{ double: true, undo }` when this press completes a double click (`undo` is what the first press changed, to hand
   * back), otherwise `{ double: false }` and the press should be handled as a single one; call `record(undo)` with what
   * that did.
   */
  press(now, armed = true) {
    const prev = this.last;
    if (armed && prev && now - prev.t <= this.ms) {
      this.last = null;
      return { double: true, undo: prev.undo };
    }
    this.last = { t: now, undo: 0 };
    return { double: false };
  }

  /** What a single press changed, so a following second press can take it back. */
  record(undo) { if (this.last) this.last.undo = undo; }
}
