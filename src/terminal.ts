import readline from "node:readline";

export function askQuestion(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export async function confirmYesNo(prompt: string): Promise<boolean> {
  const answer = await askQuestion(prompt);
  return ["y", "yes"].includes(answer.trim().toLowerCase());
}

export function writeInlineBlock(lines: string[], previousLineCount: number): void {
  if (previousLineCount > 0) {
    readline.moveCursor(process.stderr, 0, -previousLineCount);
  }

  const linesToClear = Math.max(previousLineCount, lines.length);
  for (let index = 0; index < linesToClear; index += 1) {
    const line = lines[index] ?? "";
    readline.clearLine(process.stderr, 0);
    readline.cursorTo(process.stderr, 0);
    process.stderr.write(`${line}\n`);
  }

  if (previousLineCount > lines.length) {
    readline.moveCursor(process.stderr, 0, lines.length - previousLineCount);
  }
}

export function enterAlternateScreen(): void {
  process.stderr.write("\x1b[?1049h\x1b[?25l");
}

export function leaveAlternateScreen(): void {
  process.stderr.write("\x1b[?25h\x1b[?1049l");
}

export function writeFullscreenBlock(lines: string[]): void {
  readline.cursorTo(process.stderr, 0, 0);
  readline.clearScreenDown(process.stderr);

  for (const line of lines) {
    process.stderr.write(`${line}\n`);
  }
}

export function formatRelativeAge(modifiedAtMs: number): string {
  if (!Number.isFinite(modifiedAtMs)) {
    return "?";
  }

  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - modifiedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return "0m";
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours}h`;
  }

  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) {
    return `${elapsedDays}d`;
  }

  const elapsedWeeks = Math.floor(elapsedDays / 7);
  if (elapsedWeeks < 8) {
    return `${elapsedWeeks}w`;
  }

  const elapsedMonths = Math.floor(elapsedDays / 30);
  if (elapsedMonths < 12) {
    return `${elapsedMonths}mo`;
  }

  return `${Math.floor(elapsedDays / 365)}y`;
}

export function dim(value: string, stream: NodeJS.WriteStream = process.stdout): string {
  if (!stream.isTTY || process.env.NO_COLOR) {
    return value;
  }

  return `\x1b[2m${value}\x1b[0m`;
}

export function reverse(value: string): string {
  if (!process.stderr.isTTY || process.env.NO_COLOR) {
    return value;
  }

  return `\x1b[7m${value}\x1b[0m`;
}

export function printableKeypressValue(value: string, key: readline.Key): string | null {
  if (key.ctrl || key.meta || value.length === 0) {
    return null;
  }

  return /^[^\x00-\x1F\x7F]+$/.test(value) ? value : null;
}

export function dropLastCharacter(value: string): string {
  return Array.from(value).slice(0, -1).join("");
}

export function escapeControlCharacters(value: string): string {
  return value.replace(/[\x00-\x1F\x7F]/g, "");
}
