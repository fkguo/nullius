import { z } from 'zod';
import { DiscoveryProviderCapabilitiesSchema, DiscoveryProviderIdSchema, type DiscoveryProviderId } from './capabilities.js';
import { DiscoveryQueryIntentSchema, type DiscoveryQueryIntent } from './query-intent.js';

export const DiscoveryProviderDescriptorSchema = z.object({
  provider: DiscoveryProviderIdSchema,
  display_name: z.string().min(1),
  capabilities: DiscoveryProviderCapabilitiesSchema,
  supported_intents: z.array(DiscoveryQueryIntentSchema).min(1),
  notes: z.string().optional(),
});

export type DiscoveryProviderDescriptor = z.infer<typeof DiscoveryProviderDescriptorSchema>;

export function supportsIntent(
  descriptor: DiscoveryProviderDescriptor,
  intent: DiscoveryQueryIntent,
): boolean {
  return descriptor.supported_intents.includes(intent);
}

export function getProviderDescriptor(
  descriptors: DiscoveryProviderDescriptor[],
  provider: DiscoveryProviderId,
): DiscoveryProviderDescriptor | undefined {
  return descriptors.find(descriptor => descriptor.provider === provider);
}
