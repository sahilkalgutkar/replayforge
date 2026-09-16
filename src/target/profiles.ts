// Two tenants on the same product. Same code, different configuration: labels,
// menu order, branding, and one extra confirmation step on the variant.

export interface TenantProfile {
  readonly tenantId: string;
  readonly institution: string;
  readonly productId: string;
  readonly productVersion: string;
  readonly memberNumberLabel: string;
  readonly memberWord: string;
  readonly navOrder: readonly string[];
  /** The variant asks for an identity-check acknowledgement before posting. */
  readonly extraAcknowledgement: boolean;
  readonly accentColor: string;
}

export const BASE_TENANT: TenantProfile = {
  tenantId: 'base',
  institution: 'Meridian Credit Union',
  productId: 'meridian-core',
  productVersion: '4.2.1',
  memberNumberLabel: 'Member Number',
  memberWord: 'Member',
  navOrder: ['Home', 'Member Search', 'Transactions', 'Reports', 'Sign Off'],
  extraAcknowledgement: false,
  accentColor: '#1b3a5c',
};

export const VARIANT_TENANT: TenantProfile = {
  tenantId: 'northbay',
  institution: 'Northbay Federal',
  productId: 'meridian-core',
  productVersion: '4.3.0',
  memberNumberLabel: 'Customer ID',
  memberWord: 'Customer',
  navOrder: ['Home', 'Reports', 'Customer Search', 'Transactions', 'Sign Off'],
  extraAcknowledgement: true,
  accentColor: '#5c1b2e',
};

export const PROFILES: Record<string, TenantProfile> = {
  base: BASE_TENANT,
  northbay: VARIANT_TENANT,
};

export function profileFor(tenantId: string): TenantProfile {
  const profile = PROFILES[tenantId];
  if (!profile) {
    throw new Error(
      `unknown tenant profile "${tenantId}" (known: ${Object.keys(PROFILES).join(', ')})`,
    );
  }
  return profile;
}
