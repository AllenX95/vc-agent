import { describe, expect, it } from "vitest";
import {
  applicationCommandSuggestions,
  applyComposerSuggestion,
  fileSuggestion,
  matchComposerSuggestions,
  profileSuggestion,
  skillSuggestion,
  thinkingSuggestion
} from "../../apps/desktop/src/renderer/composer-suggestions";

describe("composer suggestions", () => {
  const candidates = [
    ...applicationCommandSuggestions(),
    skillSuggestion({ packageId: "office-docs", name: "documents", description: "Create documents" }),
    profileSuggestion({ id: "profile-2", name: "Research Pro", provider: "xiaomi", model: "mimo-v2" }),
    thinkingSuggestion("high"),
    fileSuggestion("diligence/Investment Memo.pdf"),
    fileSuggestion("deck.pdf")
  ];

  it("matches skill commands and replaces only the active token", () => {
    const match = matchComposerSuggestions("/doc", 4, candidates);
    expect(match?.suggestions.map((item) => item.label)).toEqual(["/skill:documents"]);
    expect(applyComposerSuggestion("/doc later", match!, match!.suggestions[0]!)).toEqual({
      text: "/skill:documents later",
      cursor: 17
    });
  });

  it("offers application commands and their model and thinking arguments", () => {
    expect(matchComposerSuggestions("/comp", 5, candidates)?.suggestions[0]?.value).toBe("/compact");
    expect(matchComposerSuggestions("/model res", 10, candidates)?.suggestions[0]?.value).toBe("/model profile-2");
    expect(matchComposerSuggestions("/thinking hi", 12, candidates)?.suggestions[0]?.value).toBe("/thinking high");
  });

  it("matches project files and quotes paths containing spaces", () => {
    const match = matchComposerSuggestions("Review @invest", 14, candidates);
    expect(match?.suggestions[0]?.label).toBe("@diligence/Investment Memo.pdf");
    expect(applyComposerSuggestion("Review @invest", match!, match!.suggestions[0]!).text)
      .toBe('Review @"diligence/Investment Memo.pdf" ');
  });

  it("does not open suggestions for ordinary slash characters", () => {
    expect(matchComposerSuggestions("https://example.com", 19, candidates)).toBeNull();
    expect(matchComposerSuggestions("Please /doc", 11, candidates)).toBeNull();
  });
});
