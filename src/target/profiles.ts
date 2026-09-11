/**
 * Two tenants running the same vendor product. The point of the variant is that
 * it is *configured* differently, not rewritten: different institution branding,
 * different field wording, a reordered navigation menu, and one extra
 * acknowledgement step on the sub-account flow.
 *
 * A capability recorded against the base tenant has to either work here as-is or
 * fail in a way that names what drifted — that is what src/artifact/overrides.ts
 * exists to handle.
 */

export interface TenantProfile {
  readonly tenantId: string;
  readonly institution: string;
  /** The vendor product both tenants run. Capabilities are keyed on this. */
  readonly productId: string;
  readonly productVersion: string;
  /** Wording for the member-number field. Renamed by some institutions. */
  readonly memberNumberLabel: string;
  readonly memberWord: string;
  readonly navOrder: readonly string[];
  /** The variant inserts an extra acknowledgement before the confirmation. */
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
