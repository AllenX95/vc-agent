import { z } from "zod";

/**
 * The explicit context carried by a User-launched integration action.
 *
 * Optional identifiers are intentional: the renderer can explain which
 * prerequisite is missing instead of manufacturing a default Project,
 * Thread, Turn, or Profile.
 */
export const integrationTaskContextSchema = z.object({
  projectId: z.string().uuid().optional(),
  threadId: z.string().min(1).optional(),
  turnId: z.string().min(1).optional(),
  profileId: z.string().min(1).optional(),
  outputLocation: z.string().min(1).optional(),
  accessMode: z.enum(["standard", "full"])
});

export type IntegrationTaskContext = z.infer<typeof integrationTaskContextSchema>;
