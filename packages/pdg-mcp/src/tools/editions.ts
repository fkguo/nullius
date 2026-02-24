import { invalidParams } from '@autoresearch/shared';

export function chooseEdition(options: {
  preferredEdition?: string;
  requestedEdition?: string;
  availableEditions: string[];
  what: string;
}): string | undefined {
  const { preferredEdition, requestedEdition, availableEditions, what } = options;

  if (preferredEdition && availableEditions.length > 0) {
    const has = availableEditions.includes(preferredEdition);
    if (requestedEdition && !has) {
      throw invalidParams(`Requested edition not available for ${what}`, {
        requested: requestedEdition,
        available: availableEditions,
      });
    }
    if (has) return preferredEdition;
  }

  if (availableEditions.length > 0) return availableEditions[0];
  return preferredEdition;
}

