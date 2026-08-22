import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { qrMatrix, qrSvg, qrTerminal } from "../../dist/qr.js";

// Each vector was verified offline by rasterizing the matrix to RGBA pixels
// and decoding it with jsqr (round-trip matched the input text exactly).
// The size/version/digest below are pinned from that verified build.
const verifiedVectors = [
  {
    name: "short URL",
    text: "https://example.com",
    size: 25,
    version: 2,
    sha256: "93b806b398e97871698b7a997681492522147a0b49b0a0d3d84a3ade521fffad",
  },
  {
    name: "270-char string forcing a higher version",
    text: "livetree-".repeat(30),
    size: 65,
    version: 12,
    sha256: "4726a989d731c4dd2db8cd6756f10a12169aa370a8ccc46b3b6ab105aef8ccb5",
  },
  {
    name: "UTF-8 multibyte text",
    text: "héllo → 世界",
    size: 25,
    version: 2,
    sha256: "6b38daf364ad43d1a873372d3dd8ef723417cb1e65c83c0ad3015fa219ef10dd",
  },
  {
    name: "exp deep link with query params",
    text: "exp://192.168.1.42:8081/--/path?query=1&foo=bar",
    size: 33,
    version: 4,
    sha256: "d00b2b7f93bd0a767de99fac52f30ad5d3e4bb12d2cf1622a755b712d43b25e8",
  },
];

function serializeMatrix(matrix) {
  return matrix.map((row) => row.map((cell) => (cell ? "1" : "0")).join("")).join("\n");
}

function assertFinderPattern(matrix, left, top) {
  for (let dy = 0; dy < 7; dy++) {
    for (let dx = 0; dx < 7; dx++) {
      const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
      assert.equal(
        matrix[top + dy][left + dx],
        ring !== 2,
        `finder module at (${left + dx}, ${top + dy})`,
      );
    }
  }
}

test("matrices are odd squares of at least 21 modules", () => {
  for (const { text } of verifiedVectors) {
    const matrix = qrMatrix(text);
    assert.ok(matrix.length >= 21);
    assert.equal(matrix.length % 2, 1);
    for (const row of matrix) {
      assert.equal(row.length, matrix.length);
    }
  }
});

test("finder patterns sit in three corners with light separators", () => {
  const matrix = qrMatrix("https://example.com");
  const size = matrix.length;
  assertFinderPattern(matrix, 0, 0);
  assertFinderPattern(matrix, size - 7, 0);
  assertFinderPattern(matrix, 0, size - 7);
  for (let i = 0; i < 8; i++) {
    assert.equal(matrix[7][i], false);
    assert.equal(matrix[i][7], false);
    assert.equal(matrix[7][size - 1 - i], false);
    assert.equal(matrix[i][size - 8], false);
    assert.equal(matrix[size - 8][i], false);
    assert.equal(matrix[size - 1 - i][7], false);
  }
});

test("timing patterns alternate along row and column 6", () => {
  for (const text of ["https://example.com", "livetree-".repeat(30)]) {
    const matrix = qrMatrix(text);
    const size = matrix.length;
    for (let i = 8; i < size - 8; i++) {
      assert.equal(matrix[6][i], i % 2 === 0);
      assert.equal(matrix[i][6], i % 2 === 0);
    }
  }
});

test("encodes the verified vectors exactly", () => {
  for (const { name, text, size, version, sha256 } of verifiedVectors) {
    const matrix = qrMatrix(text);
    assert.equal(matrix.length, size, `${name}: size`);
    assert.equal((matrix.length - 17) / 4, version, `${name}: version`);
    assert.equal(
      createHash("sha256").update(serializeMatrix(matrix)).digest("hex"),
      sha256,
      `${name}: matrix digest`,
    );
  }
});

test("qrSvg renders a standalone SVG with a 4-module quiet zone", () => {
  const svg = qrSvg("https://example.com");
  assert.match(svg, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" /);
  assert.ok(svg.endsWith("</svg>"));
  assert.ok(svg.includes(`viewBox="0 0 33 33"`));
  assert.ok(svg.includes(`width="132" height="132"`));
  assert.ok(svg.includes(`<rect width="33" height="33" fill="#ffffff"/>`));
  assert.ok(svg.includes(`<path d="M`));
  assert.ok(svg.includes(`fill="#000000"`));
  assert.ok(qrSvg("https://example.com", 10).includes(`width="330" height="330"`));
});

test("qrTerminal renders two modules per line with a 2-module quiet zone", () => {
  const lines = qrTerminal("https://example.com").split("\n");
  const total = 25 + 4;
  assert.equal(lines.length, Math.ceil(total / 2));
  for (const line of lines) {
    assert.equal([...line].length, total);
    assert.match(line, /^[▀▄█ ]+$/u);
  }
  assert.equal(lines[0], "█".repeat(total));
  assert.ok(lines.every((line) => line.startsWith("█") || line.startsWith("▀")));
});
