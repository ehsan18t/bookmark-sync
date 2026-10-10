// Hybrid logical clock (IMPLEMENTATION.md 2.2).
// Serialized form: 15-digit wall ms, 6-digit counter, device ID, joined by "-".
// Device IDs never contain "-", so string order equals HLC order.

export type Hlc = string;

export interface HlcState {
  wall: number;
  counter: number;
}

export const HLC_ZERO_STATE: HlcState = { wall: 0, counter: 0 };

export function formatHlc(wall: number, counter: number, device: string): Hlc {
  return `${wall.toString().padStart(15, '0')}-${counter.toString().padStart(6, '0')}-${device}`;
}

export function parseHlc(h: Hlc): { wall: number; counter: number; device: string } {
  const first = h.indexOf('-');
  const second = h.indexOf('-', first + 1);
  if (first !== 15 || second !== 22) throw new Error(`malformed HLC: ${h}`);
  return {
    wall: Number(h.slice(0, first)),
    counter: Number(h.slice(first + 1, second)),
    device: h.slice(second + 1),
  };
}

/** Smallest HLC at or after the given wall time, used for "everything before time T" cutoffs. */
export function hlcFloor(wall: number): Hlc {
  return formatHlc(wall, 0, '');
}

export class HlcClock {
  private state: HlcState;

  constructor(
    readonly device: string,
    private readonly now: () => number,
    initial: HlcState = HLC_ZERO_STATE,
  ) {
    if (device.includes('-')) throw new Error('device ID must not contain "-"');
    this.state = { ...initial };
  }

  /** Next timestamp for a new op. Callers persist `snapshot()` together with the ops that use it. */
  tick(): Hlc {
    const wall = Math.max(this.state.wall, this.now());
    const counter = wall === this.state.wall ? this.state.counter + 1 : 0;
    this.state = { wall, counter };
    return formatHlc(wall, counter, this.device);
  }

  /**
   * A lower bound for every op this clock will stamp from now on, for publishing in device.json.
   * It moves the clock forward to the current wall time, so a wall clock that later steps back
   * cannot produce an op below the bound. The caller must persist `snapshot()` before publishing.
   */
  reserveBound(): Hlc {
    const wall = this.now();
    if (wall > this.state.wall) this.state = { wall, counter: 0 };
    return formatHlc(this.state.wall, this.state.counter, this.device);
  }

  /** Advance past a remote timestamp so later local ops sort after everything this device has seen. */
  observe(remote: Hlc): void {
    const r = parseHlc(remote);
    if (r.wall > this.state.wall || (r.wall === this.state.wall && r.counter > this.state.counter)) {
      this.state = { wall: r.wall, counter: r.counter };
    }
  }

  snapshot(): HlcState {
    return { ...this.state };
  }
}
