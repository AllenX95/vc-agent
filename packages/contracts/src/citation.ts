import { z } from "zod";

const publicHttpUrlSchema = z.string().url().max(2_000).refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}, "Only unauthenticated public HTTP(S) URLs are allowed.");

/** A source captured by the Host for one assistant Turn. */
export const citationSourceSchema = z.object({
  id: z.string().regex(/^S[1-9][0-9]*$/u),
  url: publicHttpUrlSchema,
  title: z.string().trim().min(1).max(500).optional(),
  accessedAt: z.string().datetime(),
  originatingTool: z.string().min(1).max(200),
  toolCallId: z.string().min(1).max(200)
});
export type CitationSource = z.infer<typeof citationSourceSchema>;

export const citationManifestSchema = z.array(citationSourceSchema).max(100);
export type CitationManifest = z.infer<typeof citationManifestSchema>;
