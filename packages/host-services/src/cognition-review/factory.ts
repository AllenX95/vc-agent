import type { CognitionReviewModuleOptions } from "./cognition-review.js";
import { CognitionReviewModule } from "./cognition-review.js";
import { JournaledFileTransactionAdapter, type JournaledFileTransactionFaultInjection } from "./journaled-file-transaction.js";

export interface CreateCognitionReviewModuleOptions extends Omit<CognitionReviewModuleOptions, "transaction"> {
  readonly transactionRoot: string;
  readonly allowedRoots: readonly string[] | (() => readonly string[]);
  readonly faultInjection?: JournaledFileTransactionFaultInjection;
}

/**
 * Composition seam for production callers.  The journal adapter remains an
 * implementation detail of Host Services; callers receive only the deep
 * CognitionReviewModule interface.
 */
export function createCognitionReviewModule(options: CreateCognitionReviewModuleOptions): CognitionReviewModule {
  const transaction = new JournaledFileTransactionAdapter({
    transactionRoot: options.transactionRoot,
    allowedRoots: options.allowedRoots,
    ...(options.faultInjection === undefined ? {} : { faultInjection: options.faultInjection })
  });
  return new CognitionReviewModule({ ...options, transaction });
}
