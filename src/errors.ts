export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

export class WorktreeRemoveNeedsForceError extends CliError {}
export class WorktreeRemovePrunableError extends CliError {}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function commandFailureMessage(error: unknown): string {
  if (!error || typeof error !== "object") {
    return errorMessage(error);
  }

  const stderr = "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "").trim() : "";
  if (stderr) {
    return stderr;
  }

  const stdout = "stdout" in error ? String((error as { stdout?: unknown }).stdout ?? "").trim() : "";
  return stdout || errorMessage(error);
}
