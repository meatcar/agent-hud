export interface Random {
  next: () => number;
  int: (maxExclusive: number) => number;
  bool: () => boolean;
  pick: <T>(items: readonly T[]) => T;
}

const seededRandom = (seed: number): Random => {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
  const int = (maxExclusive: number): number => Math.floor(next() * maxExclusive);
  return {
    next,
    int,
    bool: () => int(2) === 1,
    pick: <T>(items: readonly T[]): T => {
      const item = items[int(items.length)];
      if (item === undefined) throw new Error("Cannot pick from an empty array");
      return item;
    },
  };
};

export const checkProperty = <T>(
  seed: number,
  count: number,
  generate: (random: Random, index: number) => T,
  verify: (value: T, index: number) => void,
): void => {
  const random = seededRandom(seed);
  for (let index = 0; index < count; index += 1) {
    const value = generate(random, index);
    try {
      verify(value, index);
    } catch (error) {
      throw new Error(
        `property failed seed=${seed} index=${index} case=${JSON.stringify(value)}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
};
