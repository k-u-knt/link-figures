/** A lookup table: 256 colours a display channel maps its 0..1 intensity onto. */
export interface Lut {
  id: string;
  name: string;
  /** 256 × 3 bytes (R, G, B for each of the 256 steps). Built once and cached; callers must not change it. */
  table(): Uint8Array;
}

export class LutRegistry {
  // Re-registering an id replaces it in place and keeps its position.
  private readonly luts = new Map<string, Lut>();

  register(l: Lut): void {
    this.luts.set(l.id, l);
  }

  get(id: string): Lut | undefined {
    return this.luts.get(id);
  }

  all(): Lut[] {
    return [...this.luts.values()];
  }
}
