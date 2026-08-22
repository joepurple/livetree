// Dependency-free QR code generator (byte mode, ECC level M with an L
// fallback for capacity). The encoding algorithm is a compact port of the
// public-domain "qrcodegen" library by Project Nayuki (nayuki.io/page/qr-code-generator-library).

type EccLevel = "M" | "L";

const MIN_VERSION = 1;
const MAX_VERSION = 40;

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

const FORMAT_BITS: Record<EccLevel, number> = { M: 0, L: 1 };

const ECC_CODEWORDS_PER_BLOCK: Record<EccLevel, readonly number[]> = {
  L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
};

const NUM_ERROR_CORRECTION_BLOCKS: Record<EccLevel, readonly number[]> = {
  L: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
};

function getBit(value: number, index: number): boolean {
  return ((value >>> index) & 1) !== 0;
}

function appendBits(bits: number[], value: number, length: number): void {
  for (let i = length - 1; i >= 0; i--) {
    bits.push((value >>> i) & 1);
  }
}

function numRawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) {
      result -= 36;
    }
  }
  return result;
}

function numDataCodewords(version: number, ecc: EccLevel): number {
  return Math.floor(numRawDataModules(version) / 8)
    - ECC_CODEWORDS_PER_BLOCK[ecc][version] * NUM_ERROR_CORRECTION_BLOCKS[ecc][version];
}

function chooseVersionAndEcc(byteLength: number): { version: number; ecc: EccLevel } {
  for (const ecc of ["M", "L"] as const) {
    for (let version = MIN_VERSION; version <= MAX_VERSION; version++) {
      const neededBits = 4 + (version <= 9 ? 8 : 16) + byteLength * 8;
      if (neededBits <= numDataCodewords(version, ecc) * 8) {
        return { version, ecc };
      }
    }
  }
  throw new Error("Text is too long to encode as a QR code");
}

function makeDataCodewords(bytes: Uint8Array, version: number, ecc: EccLevel): number[] {
  const capacityBits = numDataCodewords(version, ecc) * 8;
  const bits: number[] = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, bytes.length, version <= 9 ? 8 : 16);
  for (const byte of bytes) {
    appendBits(bits, byte, 8);
  }
  appendBits(bits, 0, Math.min(4, capacityBits - bits.length));
  appendBits(bits, 0, (8 - bits.length % 8) % 8);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) {
    appendBits(bits, pad, 8);
  }
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i++) {
    if (i % 8 === 0) {
      codewords.push(0);
    }
    codewords[i >>> 3] |= bits[i] << (7 - (i & 7));
  }
  return codewords;
}

function reedSolomonMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function reedSolomonDivisor(degree: number): number[] {
  const result: number[] = new Array(degree - 1).fill(0);
  result.push(1);
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = reedSolomonMultiply(result[j], root);
      if (j + 1 < result.length) {
        result[j] ^= result[j + 1];
      }
    }
    root = reedSolomonMultiply(root, 0x02);
  }
  return result;
}

function reedSolomonRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result: number[] = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ (result.shift() ?? 0);
    result.push(0);
    divisor.forEach((coefficient, i) => {
      result[i] ^= reedSolomonMultiply(coefficient, factor);
    });
  }
  return result;
}

function addEccAndInterleave(data: readonly number[], version: number, ecc: EccLevel): number[] {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecc][version];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecc][version];
  const rawCodewords = Math.floor(numRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - rawCodewords % numBlocks;
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const blocks: number[][] = [];
  const divisor = reedSolomonDivisor(blockEccLen);
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const block = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += block.length;
    const eccCodewords = reedSolomonRemainder(block, divisor);
    if (i < numShortBlocks) {
      block.push(0);
    }
    blocks.push(block.concat(eccCodewords));
  }

  const result: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) {
        result.push(block[i]);
      }
    });
  }
  return result;
}

function getAlignmentPatternPositions(version: number, size: number): number[] {
  if (version === 1) {
    return [];
  }
  const numAlign = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) {
    result.splice(1, 0, pos);
  }
  return result;
}

function finderPenaltyCountPatterns(runHistory: readonly number[]): number {
  const n = runHistory[1];
  const core = n > 0
    && runHistory[2] === n
    && runHistory[3] === n * 3
    && runHistory[4] === n
    && runHistory[5] === n;
  return (core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0)
    + (core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0);
}

function finderPenaltyAddHistory(currentRunLength: number, runHistory: number[], size: number): void {
  if (runHistory[0] === 0) {
    currentRunLength += size;
  }
  runHistory.pop();
  runHistory.unshift(currentRunLength);
}

function finderPenaltyTerminateAndCount(
  currentRunColor: boolean,
  currentRunLength: number,
  runHistory: number[],
  size: number,
): number {
  if (currentRunColor) {
    finderPenaltyAddHistory(currentRunLength, runHistory, size);
    currentRunLength = 0;
  }
  finderPenaltyAddHistory(currentRunLength + size, runHistory, size);
  return finderPenaltyCountPatterns(runHistory);
}

function buildMatrix(version: number, ecc: EccLevel, dataCodewords: readonly number[]): boolean[][] {
  const size = version * 4 + 17;
  const modules: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const isFunction: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));

  const setFunctionModule = (x: number, y: number, dark: boolean): void => {
    modules[y][x] = dark;
    isFunction[y][x] = true;
  };

  const drawFinderPattern = (x: number, y: number): void => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) {
          setFunctionModule(xx, yy, distance !== 2 && distance !== 4);
        }
      }
    }
  };

  const drawAlignmentPattern = (x: number, y: number): void => {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  };

  const drawFormatBits = (mask: number): void => {
    const data = FORMAT_BITS[ecc] << 3 | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) {
      rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    }
    const bits = (data << 10 | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) {
      setFunctionModule(8, i, getBit(bits, i));
    }
    setFunctionModule(8, 7, getBit(bits, 6));
    setFunctionModule(8, 8, getBit(bits, 7));
    setFunctionModule(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) {
      setFunctionModule(14 - i, 8, getBit(bits, i));
    }
    for (let i = 0; i < 8; i++) {
      setFunctionModule(size - 1 - i, 8, getBit(bits, i));
    }
    for (let i = 8; i < 15; i++) {
      setFunctionModule(8, size - 15 + i, getBit(bits, i));
    }
    setFunctionModule(8, size - 8, true);
  };

  const drawVersionInfo = (): void => {
    if (version < 7) {
      return;
    }
    let rem = version;
    for (let i = 0; i < 12; i++) {
      rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    }
    const bits = version << 12 | rem;
    for (let i = 0; i < 18; i++) {
      const dark = getBit(bits, i);
      const a = size - 11 + i % 3;
      const b = Math.floor(i / 3);
      setFunctionModule(a, b, dark);
      setFunctionModule(b, a, dark);
    }
  };

  const drawCodewords = (allCodewords: readonly number[]): void => {
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) {
        right = 5;
      }
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!isFunction[y][x] && i < allCodewords.length * 8) {
            modules[y][x] = getBit(allCodewords[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  };

  const applyMask = (mask: number): void => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let invert: boolean;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = x * y % 2 + x * y % 3 === 0; break;
          case 6: invert = (x * y % 2 + x * y % 3) % 2 === 0; break;
          default: invert = ((x + y) % 2 + x * y % 3) % 2 === 0; break;
        }
        if (!isFunction[y][x] && invert) {
          modules[y][x] = !modules[y][x];
        }
      }
    }
  };

  const getPenaltyScore = (): number => {
    let result = 0;
    for (let y = 0; y < size; y++) {
      let runColor = false;
      let runX = 0;
      const runHistory = [0, 0, 0, 0, 0, 0, 0];
      for (let x = 0; x < size; x++) {
        if (modules[y][x] === runColor) {
          runX++;
          if (runX === 5) {
            result += PENALTY_N1;
          } else if (runX > 5) {
            result++;
          }
        } else {
          finderPenaltyAddHistory(runX, runHistory, size);
          if (!runColor) {
            result += finderPenaltyCountPatterns(runHistory) * PENALTY_N3;
          }
          runColor = modules[y][x];
          runX = 1;
        }
      }
      result += finderPenaltyTerminateAndCount(runColor, runX, runHistory, size) * PENALTY_N3;
    }
    for (let x = 0; x < size; x++) {
      let runColor = false;
      let runY = 0;
      const runHistory = [0, 0, 0, 0, 0, 0, 0];
      for (let y = 0; y < size; y++) {
        if (modules[y][x] === runColor) {
          runY++;
          if (runY === 5) {
            result += PENALTY_N1;
          } else if (runY > 5) {
            result++;
          }
        } else {
          finderPenaltyAddHistory(runY, runHistory, size);
          if (!runColor) {
            result += finderPenaltyCountPatterns(runHistory) * PENALTY_N3;
          }
          runColor = modules[y][x];
          runY = 1;
        }
      }
      result += finderPenaltyTerminateAndCount(runColor, runY, runHistory, size) * PENALTY_N3;
    }
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const color = modules[y][x];
        if (color === modules[y][x + 1] && color === modules[y + 1][x] && color === modules[y + 1][x + 1]) {
          result += PENALTY_N2;
        }
      }
    }
    let dark = 0;
    for (const row of modules) {
      for (const cell of row) {
        if (cell) {
          dark++;
        }
      }
    }
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    return result + k * PENALTY_N4;
  };

  for (let i = 0; i < size; i++) {
    setFunctionModule(6, i, i % 2 === 0);
    setFunctionModule(i, 6, i % 2 === 0);
  }
  drawFinderPattern(3, 3);
  drawFinderPattern(size - 4, 3);
  drawFinderPattern(3, size - 4);
  const alignPositions = getAlignmentPatternPositions(version, size);
  const numAlign = alignPositions.length;
  for (let i = 0; i < numAlign; i++) {
    for (let j = 0; j < numAlign; j++) {
      const skip = (i === 0 && j === 0) || (i === 0 && j === numAlign - 1) || (i === numAlign - 1 && j === 0);
      if (!skip) {
        drawAlignmentPattern(alignPositions[i], alignPositions[j]);
      }
    }
  }
  drawFormatBits(0);
  drawVersionInfo();
  drawCodewords(addEccAndInterleave(dataCodewords, version, ecc));

  let bestMask = 0;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask);
    drawFormatBits(mask);
    const penalty = getPenaltyScore();
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
    }
    applyMask(mask);
  }
  applyMask(bestMask);
  drawFormatBits(bestMask);

  return modules;
}

export function qrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  const { version, ecc } = chooseVersionAndEcc(bytes.length);
  return buildMatrix(version, ecc, makeDataCodewords(bytes, version, ecc));
}

export function qrTerminal(text: string): string {
  const matrix = qrMatrix(text);
  const quiet = 2;
  const size = matrix.length;
  const total = size + quiet * 2;
  const isDark = (x: number, y: number): boolean => {
    const mx = x - quiet;
    const my = y - quiet;
    return mx >= 0 && my >= 0 && mx < size && my < size ? matrix[my][mx] : false;
  };
  const lines: string[] = [];
  for (let y = 0; y < total; y += 2) {
    let line = "";
    for (let x = 0; x < total; x++) {
      const top = !isDark(x, y);
      const bottom = y + 1 < total && !isDark(x, y + 1);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

export function qrSvg(text: string, moduleSize = 4): string {
  const matrix = qrMatrix(text);
  const quiet = 4;
  const size = matrix.length;
  const dimension = size + quiet * 2;
  const pixels = dimension * moduleSize;
  const path: string[] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (matrix[y][x]) {
        path.push(`M${x + quiet},${y + quiet}h1v1h-1z`);
      }
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<svg xmlns="http://www.w3.org/2000/svg" width="${pixels}" height="${pixels}" `
    + `viewBox="0 0 ${dimension} ${dimension}" shape-rendering="crispEdges">`
    + `<rect width="${dimension}" height="${dimension}" fill="#ffffff"/>`
    + `<path d="${path.join("")}" fill="#000000"/></svg>`;
}
