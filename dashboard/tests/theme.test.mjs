import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const dashboardDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(path.join(dashboardDir, "src", "styles.css"), "utf8");
const themeSource = readFileSync(path.join(dashboardDir, "src", "theme.ts"), "utf8");
const html = readFileSync(path.join(dashboardDir, "index.html"), "utf8");

function extractBlock(source, startIndex) {
  const open = source.indexOf("{", startIndex);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return { body: source.slice(open + 1, i), end: i + 1 };
    }
  }
  throw new Error("Unbalanced braces in styles.css");
}

function parseTokens(block) {
  const tokens = new Map();
  for (const match of block.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    tokens.set(match[1], match[2].trim());
  }
  return tokens;
}

const rootBlock = extractBlock(css, css.indexOf(":root"));
const lightMediaIndex = css.indexOf("@media (prefers-color-scheme: light)");
assert.ok(lightMediaIndex > 0, "styles.css must define a light palette behind prefers-color-scheme");
const lightMedia = extractBlock(css, lightMediaIndex);
const lightBlock = extractBlock(lightMedia.body, lightMedia.body.indexOf(":root"));

const darkTokens = parseTokens(rootBlock.body);
const lightTokens = parseTokens(lightBlock.body);

function hexToRgb(value) {
  const hex = value.replace("#", "");
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16));
}

function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((channel) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test("light palette defines exactly the same tokens as dark", () => {
  assert.ok(darkTokens.size > 30, "expected a substantial dark token set");
  assert.deepEqual([...lightTokens.keys()].sort(), [...darkTokens.keys()].sort());
});

test("color-scheme advertises both appearances", () => {
  assert.match(rootBlock.body, /color-scheme:\s*light dark/);
});

test("no raw colors outside the token blocks in styles.css", () => {
  const outside =
    css.slice(0, css.indexOf(":root")) +
    css.slice(css.indexOf(":root") + rootBlock.end, lightMediaIndex) +
    css.slice(lightMediaIndex + lightMedia.end);
  const strayHex = outside.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.deepEqual(strayHex, [], `hex colors must live in the token blocks: ${strayHex.join(", ")}`);
  const strayRgb = outside.match(/rgba?\(/g) ?? [];
  assert.deepEqual(strayRgb, [], "rgb()/rgba() colors must live in the token blocks");
});

const contrastPairs = [
  // [foreground token, background token, minimum ratio]
  ["text", "bg", 9],
  ["text", "panel", 9],
  ["text", "panel-2", 8],
  ["text", "hover", 8],
  ["text", "active", 7],
  ["text-soft", "hover", 4.5],
  ["text-soft", "panel-2", 4.5],
  ["muted", "bg", 4.5],
  ["muted", "panel", 4.5],
  ["muted", "hover", 4.5],
  ["label", "bg", 4],
  ["label", "panel", 4],
  ["dim", "bg", 3.3],
  ["dim", "panel", 3.3],
  ["accent", "bg", 7],
  ["ok-contrast", "ok", 4.5],
  ["ok", "ok-surface", 3],
  ["danger", "bg", 4],
  ["danger", "panel-2", 4],
  ["danger-strong", "danger-surface", 4.5],
  ["danger-soft", "danger-surface", 4],
  ["warn-text", "panel", 4],
  ["info-text", "panel", 4],
];

for (const [name, tokens] of [["dark", darkTokens], ["light", lightTokens]]) {
  test(`${name} palette meets contrast targets`, () => {
    for (const [fg, bg, minimum] of contrastPairs) {
      const fgValue = tokens.get(fg);
      const bgValue = tokens.get(bg);
      assert.ok(fgValue && bgValue, `missing token --${fg} or --${bg} in ${name} palette`);
      assert.match(fgValue, /^#/, `--${fg} must be an opaque hex color for contrast checking`);
      assert.match(bgValue, /^#/, `--${bg} must be an opaque hex color for contrast checking`);
      const ratio = contrast(fgValue, bgValue);
      assert.ok(
        ratio >= minimum,
        `${name}: --${fg} on --${bg} is ${ratio.toFixed(2)}:1, expected >= ${minimum}:1`,
      );
    }
  });
}

function parseTerminalThemes() {
  const match = themeSource.match(/export const terminalThemes[^=]*=\s*(\{[\s\S]*?\n\});/);
  assert.ok(match, "theme.ts must export terminalThemes as a plain object literal");
  return new Function(`return ${match[1]}`)();
}

const terminalThemes = parseTerminalThemes();

test("terminal palettes cover both appearances with identical keys", () => {
  assert.deepEqual(Object.keys(terminalThemes).sort(), ["dark", "light"]);
  assert.deepEqual(Object.keys(terminalThemes.dark).sort(), Object.keys(terminalThemes.light).sort());
});

test("terminal backgrounds match the --inset surface token", () => {
  assert.equal(terminalThemes.dark.background, darkTokens.get("inset"));
  assert.equal(terminalThemes.light.background, lightTokens.get("inset"));
});

for (const appearance of ["dark", "light"]) {
  test(`${appearance} terminal palette is readable`, () => {
    const palette = terminalThemes[appearance];
    assert.ok(contrast(palette.foreground, palette.background) >= 4.5, "foreground vs background");
    for (const key of ["cursor", "red", "green", "blue", "yellow", "brightGreen", "brightBlue"]) {
      const ratio = contrast(palette[key], palette.background);
      assert.ok(ratio >= 3, `${appearance} terminal ${key} is ${ratio.toFixed(2)}:1 vs background, expected >= 3:1`);
    }
  });
}

test("index.html declares a theme-color for each appearance matching --bg", () => {
  const metas = [...html.matchAll(/<meta name="theme-color" media="\(prefers-color-scheme: (dark|light)\)" content="([^"]+)"/g)];
  const byScheme = Object.fromEntries(metas.map((m) => [m[1], m[2]]));
  assert.equal(byScheme.dark, darkTokens.get("bg"));
  assert.equal(byScheme.light, lightTokens.get("bg"));
});
