export const isObject = (val: unknown): val is Record<string, unknown> =>
  typeof val === "object" && val !== null;

const dig = (obj: unknown, keys: string[]): unknown => {
  let cur: unknown = obj;
  for (const key of keys) {
    cur = isObject(cur) ? cur[key] : undefined;
  }
  return cur;
};

export const getString = (obj: unknown, ...keys: string[]): string | undefined => {
  const val = dig(obj, keys);
  return typeof val === "string" ? val : undefined;
};

export const getNumber = (obj: unknown, ...keys: string[]): number | undefined => {
  const val = dig(obj, keys);
  return typeof val === "number" ? val : undefined;
};

export const getStringOrNumber = (obj: unknown, ...keys: string[]): string | number | undefined => {
  const val = dig(obj, keys);
  if (typeof val === "string" || typeof val === "number") {
    return val;
  }
  return undefined;
};
