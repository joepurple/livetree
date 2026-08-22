import { CliError } from "./errors.js";

export type TemplateToken = {
  raw: string;
  kind: "url" | "tunnelUrl";
  script: string;
  encode: boolean;
};

export type TokenResolver = {
  urlForScript(script: string): string;
  tunnelUrlForScript(script: string): string;
};

const TOKEN_PATTERN = /\$\{([^}]*)\}/g;

export function templateTokens(template: string): TemplateToken[] {
  return [...template.matchAll(TOKEN_PATTERN)].map((match) => parseToken(match[0], match[1] ?? ""));
}

export function interpolateTemplate(template: string, resolver: TokenResolver): string {
  return template.replace(TOKEN_PATTERN, (raw, inner: string) => {
    const token = parseToken(raw, inner);
    const value = token.kind === "url" ? resolver.urlForScript(token.script) : resolver.tunnelUrlForScript(token.script);
    return token.encode ? encodeURIComponent(value) : value;
  });
}

function parseToken(raw: string, inner: string): TemplateToken {
  const parts = inner.split(":");
  const encode = parts[0] === "enc";
  if (encode) {
    parts.shift();
  }

  const [kind, script, ...rest] = parts;
  if ((kind !== "url" && kind !== "tunnelUrl") || !script || rest.length > 0) {
    throw new CliError(`Unknown template token '${raw}'. Supported tokens: \${url:<script>}, \${tunnelUrl:<script>}, and \${enc:...} variants.`);
  }

  return { raw, kind, script, encode };
}
