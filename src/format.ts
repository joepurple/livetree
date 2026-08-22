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
