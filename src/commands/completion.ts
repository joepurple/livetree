import path from "node:path";
import type { ProjectContext, WorktreeChoice } from "../types.js";

const commands = [
  "use",
  "ls",
  "cd",
  "init",
  "run",
  "watch",
  ":",
  "run:",
  "watch:",
  "rm",
  "install",
];

export function zshCompletionScript(): string {
  return `#compdef lt

_lt() {
  local -a commands selectors at_selectors

  commands=(${commands.map((command) => zshQuote(command)).join(" ")})

  if (( CURRENT == 2 )); then
    if [[ "$PREFIX" == @* ]]; then
      selectors=("\${(@f)$(command lt __complete selectors "\${PREFIX#@}")}")
      at_selectors=("\${(@)^selectors/#/@}")
      compadd -- "\${at_selectors[@]}"
      return
    fi

    _describe -t commands 'lt command' commands
    return
  fi

  case "$words[2]" in
    use|cd)
      selectors=("\${(@f)$(command lt __complete selectors "$PREFIX")}")
      compadd -- "\${selectors[@]}"
      ;;
    @)
      selectors=("\${(@f)$(command lt __complete selectors "$PREFIX")}")
      compadd -- "\${selectors[@]}"
      ;;
  esac
}

compdef _lt lt`;
}

export function completeSelectors(context: ProjectContext, prefix = ""): string[] {
  const normalizedPrefix = prefix.toLowerCase();
  return selectorCandidates(context.choices).filter((candidate) => candidate.toLowerCase().startsWith(normalizedPrefix));
}

function selectorCandidates(choices: WorktreeChoice[]): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];

  const add = (value: string | null | undefined): void => {
    if (!value || seen.has(value)) {
      return;
    }

    seen.add(value);
    candidates.push(value);
  };

  for (const choice of choices) {
    if (choice.isMain) {
      add("root");
    }

    add(choice.branch);
    add(path.basename(choice.path));
    add(choice.head && !/^0+$/.test(choice.head) ? choice.head.slice(0, 12) : null);
    const chats = choice.chats.length > 0 ? choice.chats : choice.chat ? [choice.chat] : [];
    for (const chat of chats) {
      add(chat.threadId);
      add(chat.title);
    }
    add(choice.path);
  }

  return candidates.sort((left, right) => left.localeCompare(right));
}

function zshQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
