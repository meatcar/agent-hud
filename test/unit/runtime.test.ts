import { expect, test } from "bun:test";
import { brotliDecompressSync } from "node:zlib";

test("Bun rejects the invalid Brotli block switch with errno -17", () => {
  expect(() =>
    brotliDecompressSync(Buffer.from("200010414141fcffff07002228f00b60f7f41f000000", "hex")),
  ).toThrow(expect.objectContaining({ errno: -17 }));
});
