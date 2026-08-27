import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const dashboardDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(path.join(dashboardDir, "src", "styles.css"), "utf8");
const app = readFileSync(path.join(dashboardDir, "src", "App.tsx"), "utf8");
const mobileCss = css.slice(css.indexOf("@media (max-width: 820px)"), css.indexOf("@media (max-width: 620px)"));
const compactMobileCss = css.slice(css.indexOf("@media (max-width: 620px)"));

test("mobile server and shortcut links meet the 44px minimum tap target", () => {
  assert.match(mobileCss, /\.server-primary-link, \.server-tunnel-link, \.shortcut-link \{[^}]*width:\s*44px;[^}]*height:\s*44px;/);
});

test("available mobile shortcuts render as a clean row with an icon-only action", () => {
  assert.match(mobileCss, /\.link-card--available \{[^}]*min-height:\s*64px;/);
  assert.match(mobileCss, /\.link-card--available \.link-card__heading > \.ui-badge, \.link-card--available \.qr-details \{[^}]*display:\s*none;/);
  assert.match(app, /<strong>\{link\.name\}<\/strong>/);
  assert.match(app, /class="shortcut-link"[\s\S]{0,300}aria-label=\{`Open \$\{link\.name\}`\}[\s\S]{0,300}<ArrowUpRight/);
  assert.doesNotMatch(app, /class="shortcut-link"[\s\S]{0,300}<span>\{link\.name\}<\/span>/);
  assert.doesNotMatch(app, /shortcut-link__icon/);
  assert.doesNotMatch(css, /\.shortcut-link__icon/);
});

test("server names are labels and open actions are icon-only", () => {
  assert.match(app, /<strong>\{script\.script\}<\/strong>/);
  assert.match(app, /class="server-primary-link"[\s\S]{0,300}aria-label=\{`Open \$\{script\.script\}`\}[\s\S]{0,300}<ArrowUpRight/);
  assert.doesNotMatch(app, /class="server-icon"/);
  assert.doesNotMatch(css, /\.server-icon(?:--running)?\s*\{/);
});

test("compact mobile server cards keep links and controls in one row", () => {
  assert.match(compactMobileCss, /\.server-card \{[^}]*display:\s*flex;[^}]*align-items:\s*center;/);
  assert.match(compactMobileCss, /\.server-card__actions \.ui-button--icon \{[^}]*width:\s*40px;[^}]*height:\s*40px;/);
});
