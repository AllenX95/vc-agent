export type ComposerSuggestion = {
  readonly id: string;
  readonly kind: "command" | "skill" | "file" | "profile" | "thinking";
  readonly value: string;
  readonly label: string;
  readonly description: string;
};

export type ComposerSuggestionMatch = {
  readonly start: number;
  readonly end: number;
  readonly suggestions: readonly ComposerSuggestion[];
};

const APPLICATION_COMMANDS = [
  { name: "model", description: "Switch the active Model Profile" },
  { name: "compact", description: "Compact this conversation context" },
  { name: "thinking", description: "Change the active Profile reasoning level" },
  { name: "dream", description: "Open the Dream workflow" },
  { name: "reflection", description: "Open Investment Reflection" }
] as const;

export function applicationCommandSuggestions(): readonly ComposerSuggestion[] {
  return APPLICATION_COMMANDS.map((command) => ({
    id: `command:${command.name}`,
    kind: "command",
    value: `/${command.name}`,
    label: `/${command.name}`,
    description: command.description
  }));
}

export function skillSuggestion(input: { packageId: string; name: string; description?: string }): ComposerSuggestion {
  const name = input.name.trim() || input.packageId;
  return {
    id: `skill:${input.packageId}`,
    kind: "skill",
    value: `/skill:${name}`,
    label: `/skill:${name}`,
    description: input.description?.trim() || `Activate ${input.packageId}`
  };
}

export function profileSuggestion(input: { id: string; name: string; provider: string; model: string }): ComposerSuggestion {
  return {
    id: `profile:${input.id}`,
    kind: "profile",
    value: `/model ${input.id}`,
    label: input.name,
    description: `${input.provider} / ${input.model}`
  };
}

export function thinkingSuggestion(level: string): ComposerSuggestion {
  return {
    id: `thinking:${level}`,
    kind: "thinking",
    value: `/thinking ${level}`,
    label: level,
    description: level === "off" ? "Disable model reasoning" : `Set reasoning to ${level}`
  };
}

export function fileSuggestion(relativePath: string): ComposerSuggestion {
  const quoted = /\s/u.test(relativePath) ? `"${relativePath.replaceAll("\"", "\\\"")}"` : relativePath;
  return {
    id: `file:${relativePath}`,
    kind: "file",
    value: `@${quoted}`,
    label: `@${relativePath}`,
    description: "Project file"
  };
}

export function matchComposerSuggestions(
  text: string,
  cursor: number,
  candidates: readonly ComposerSuggestion[]
): ComposerSuggestionMatch | null {
  const safeCursor = Math.max(0, Math.min(cursor, text.length));
  const prefix = text.slice(0, safeCursor);
  const argumentMatch = prefix.match(/^\s*\/(model|thinking)\s+([^\n]*)$/u);
  if (argumentMatch !== null) {
    const kind = argumentMatch[1] === "model" ? "profile" : "thinking";
    const query = argumentMatch[2]!.trim().toLocaleLowerCase();
    const suggestions = candidates
      .filter((candidate) => candidate.kind === kind)
      .filter((candidate) => `${candidate.label} ${candidate.description} ${candidate.value}`.toLocaleLowerCase().includes(query))
      .slice(0, 8);
    if (suggestions.length === 0) return null;
    return { start: prefix.search(/\//u), end: safeCursor, suggestions };
  }

  const slashMatch = prefix.match(/^\s*\/([^\s]*)$/u);
  if (slashMatch !== null) {
    const query = slashMatch[1]!.toLocaleLowerCase();
    const suggestions = candidates
      .filter((candidate) => candidate.kind === "command" || candidate.kind === "skill")
      .filter((candidate) => candidate.label.slice(1).toLocaleLowerCase().includes(query))
      .slice(0, 8);
    if (suggestions.length === 0) return null;
    return { start: prefix.search(/\//u), end: safeCursor, suggestions };
  }

  const fileMatch = prefix.match(/(?:^|\s)@([^\s]*)$/u);
  if (fileMatch === null) return null;
  const query = fileMatch[1]!.toLocaleLowerCase();
  const suggestions = candidates
    .filter((candidate) => candidate.kind === "file")
    .filter((candidate) => candidate.label.slice(1).toLocaleLowerCase().includes(query))
    .slice(0, 8);
  if (suggestions.length === 0) return null;
  return {
    start: safeCursor - query.length - 1,
    end: safeCursor,
    suggestions
  };
}

export function applyComposerSuggestion(
  text: string,
  match: Pick<ComposerSuggestionMatch, "start" | "end">,
  suggestion: ComposerSuggestion
): { readonly text: string; readonly cursor: number } {
  const insertion = `${suggestion.value} `;
  const suffix = text.slice(match.end);
  return {
    text: text.slice(0, match.start) + insertion + (/^\s/u.test(suffix) ? suffix.slice(1) : suffix),
    cursor: match.start + insertion.length
  };
}
