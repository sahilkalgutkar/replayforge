import type { CapabilityArtifact } from '../../src/artifact/schema.js';
import { capabilityArtifactSchema } from '../../src/artifact/schema.js';

/**
 * The member-savings-balance capability, as the discovery agent produces it.
 * Tests build from this rather than from a discovery run so they stay
 * deterministic and free of model calls; the committed artifact under
 * evidence/ is the one an actual run emitted.
 */
export function sampleArtifact(overrides: Partial<CapabilityArtifact> = {}): CapabilityArtifact {
  return capabilityArtifactSchema.parse({
    schemaVersion: 1,
    id: 'meridian-core.member_savings_balance',
    version: 1,
    name: 'member_savings_balance',
    title: 'Look up a member’s regular savings balance',
    description:
      'Signs on to the core servicing console, searches for a member by number, opens their accounts tab and returns the balance and account number of their Regular Savings account.',
    app: {
      productId: 'meridian-core',
      productVersion: '4.2.1',
      surface: 'browser',
      entryUrl: '{{baseUrl}}/',
      bindingVariables: ['baseUrl'],
      recordedOnTenant: 'base',
    },
    inputs: [
      {
        name: 'memberNumber',
        type: 'string',
        required: true,
        description: 'The member number to look up.',
        sensitivity: 'internal',
        pattern: '^[0-9]{4,10}$',
        example: '10021',
      },
    ],
    outputs: [
      {
        name: 'memberName',
        type: 'string',
        description: 'Name on the membership.',
        sensitivity: 'pii',
        from: 'memberName',
      },
      {
        name: 'savingsBalance',
        type: 'number',
        description: 'Current balance of the Regular Savings account.',
        sensitivity: 'internal',
        from: 'savingsBalance',
      },
      {
        name: 'savingsAccountNumber',
        type: 'string',
        description: 'Account number of the Regular Savings account.',
        sensitivity: 'internal',
        from: 'savingsAccountNumber',
      },
    ],
    secrets: [
      { ref: 'core_username', description: 'Service teller user id.', envVar: 'MERIDIAN_USERNAME' },
      { ref: 'core_password', description: 'Service teller password.', envVar: 'MERIDIAN_PASSWORD' },
    ],
    preconditions: [],
    steps: [
      {
        id: 'open_console',
        intent: 'Open the core servicing sign-on screen.',
        action: { kind: 'navigate', url: { kind: 'template', template: '{{baseUrl}}/' } },
        risk: 'safe',
        checkpoint: { kind: 'textPresent', text: { mode: 'contains', value: 'Sign On' } },
      },
      {
        id: 'enter_user',
        intent: 'Type the service user id.',
        action: {
          kind: 'type',
          target: {
            description: 'the user id field, identified by the "User ID" label in the cell beside it',
            primary: { role: 'textbox', editable: true, nearbyText: { mode: 'equals', value: 'User ID' } },
          },
          value: { kind: 'secret', ref: 'core_username' },
        },
        risk: 'safe',
      },
      {
        id: 'enter_password',
        intent: 'Type the service password.',
        action: {
          kind: 'type',
          target: {
            description: 'the password field, identified by the "Password" label in the cell beside it',
            primary: { role: 'textbox', editable: true, nearbyText: { mode: 'equals', value: 'Password' } },
          },
          value: { kind: 'secret', ref: 'core_password' },
        },
        risk: 'safe',
      },
      {
        id: 'sign_on',
        intent: 'Submit the sign-on form.',
        action: {
          kind: 'click',
          target: {
            description: 'the Sign On submit button',
            primary: { role: 'button', name: { mode: 'equals', value: 'Sign On' } },
          },
        },
        risk: 'sensitive',
        checkpoint: {
          kind: 'targetPresent',
          target: {
            description: 'the menu frame, which only renders once signed on',
            primary: { role: 'link', name: { mode: 'contains', value: 'Search' }, framePath: ['navFrame'] },
          },
        },
      },
      {
        id: 'open_search',
        intent: 'Open the member search screen from the menu.',
        action: {
          kind: 'click',
          target: {
            description: 'the member search item in the menu frame',
            primary: { role: 'link', name: { mode: 'equals', value: 'Member Search' }, framePath: ['navFrame'] },
            fallbacks: [
              { role: 'link', name: { mode: 'contains', value: 'Search' }, framePath: ['navFrame'] },
            ],
          },
        },
        risk: 'safe',
        guards: [
          {
            name: 'dismiss-system-notice',
            when: { kind: 'textPresent', text: { mode: 'contains', value: 'System Notice' } },
            then: {
              kind: 'click',
              target: {
                description: 'the Acknowledge button on the maintenance notice',
                primary: { role: 'button', name: { mode: 'equals', value: 'Acknowledge' } },
              },
            },
            maxFirings: 2,
          },
        ],
        checkpoint: {
          kind: 'targetPresent',
          target: {
            description: 'the member number entry field on the search screen',
            primary: {
              role: 'textbox',
              editable: true,
              nearbyText: { mode: 'contains', value: 'Member Number' },
              framePath: ['mainFrame'],
            },
          },
        },
      },
      {
        id: 'enter_member_number',
        intent: 'Type the member number being looked up.',
        action: {
          kind: 'type',
          target: {
            description: 'the member number field, identified by the label in the cell to its left',
            primary: {
              role: 'textbox',
              editable: true,
              nearbyText: { mode: 'contains', value: 'Member Number' },
              framePath: ['mainFrame'],
            },
          },
          value: { kind: 'param', name: 'memberNumber' },
        },
        risk: 'safe',
        guards: [
          {
            name: 'dismiss-system-notice',
            when: { kind: 'textPresent', text: { mode: 'contains', value: 'System Notice' } },
            then: {
              kind: 'click',
              target: {
                description: 'the Acknowledge button on the maintenance notice',
                primary: { role: 'button', name: { mode: 'equals', value: 'Acknowledge' } },
              },
            },
            maxFirings: 2,
          },
        ],
      },
      {
        id: 'run_search',
        intent: 'Run the search.',
        action: {
          kind: 'click',
          target: {
            description: 'the Search submit button on the search form',
            primary: { role: 'button', name: { mode: 'equals', value: 'Search' }, framePath: ['mainFrame'] },
          },
        },
        risk: 'safe',
        checkpoint: {
          kind: 'any',
          of: [
            { kind: 'textPresent', text: { mode: 'contains', value: 'record(s)' } },
            { kind: 'textPresent', text: { mode: 'contains', value: 'No records found' } },
          ],
        },
      },
      {
        id: 'open_member',
        intent: 'Open the matching member record.',
        action: {
          kind: 'click',
          target: {
            description: 'the result row link whose text is the member number that was searched for',
            primary: {
              role: 'link',
              name: { mode: 'equals', value: '{{memberNumber}}' },
              framePath: ['mainFrame'],
            },
          },
        },
        risk: 'safe',
        checkpoint: { kind: 'textPresent', text: { mode: 'contains', value: 'Date of Birth' } },
      },
      {
        id: 'read_member_name',
        intent: 'Read the name on the membership from the profile table.',
        action: {
          kind: 'read',
          target: {
            description: 'the value cell of the Name row on the profile table',
            primary: {
              role: 'cell',
              framePath: ['mainFrame'],
              inTable: { rowContains: { mode: 'equals', value: 'Name' }, column: 1 },
            },
          },
          into: 'memberName',
          from: 'text',
          transform: { kind: 'trim' },
        },
        risk: 'safe',
      },
      {
        id: 'open_accounts',
        intent: 'Switch to the accounts tab.',
        action: {
          kind: 'click',
          target: {
            description: 'the Accounts tab on the member record',
            primary: { role: 'link', name: { mode: 'equals', value: 'Accounts' }, framePath: ['mainFrame'] },
          },
        },
        risk: 'safe',
        checkpoint: { kind: 'textPresent', text: { mode: 'contains', value: 'Current Balance' } },
      },
      {
        id: 'read_savings_balance',
        intent: 'Read the current balance from the Regular Savings row.',
        action: {
          kind: 'read',
          target: {
            description:
              'the Current Balance cell of the row whose account type is Regular Savings, addressed by row key and column header rather than by position',
            primary: {
              role: 'cell',
              framePath: ['mainFrame'],
              inTable: {
                rowContains: { mode: 'equals', value: 'Regular Savings' },
                column: 'Current Balance',
              },
            },
          },
          into: 'savingsBalance',
          from: 'text',
          transform: { kind: 'currencyToNumber' },
        },
        risk: 'safe',
      },
      {
        id: 'read_savings_account_number',
        intent: 'Read the account number from the Regular Savings row.',
        action: {
          kind: 'read',
          target: {
            description: 'the Account Number cell of the Regular Savings row',
            primary: {
              role: 'cell',
              framePath: ['mainFrame'],
              inTable: {
                rowContains: { mode: 'equals', value: 'Regular Savings' },
                column: 'Account Number',
              },
            },
          },
          into: 'savingsAccountNumber',
          from: 'text',
          transform: { kind: 'trim' },
        },
        risk: 'safe',
      },
    ],
    outcomes: [
      {
        name: 'MEMBER_NOT_FOUND',
        description: 'The core holds no member with that number. A legitimate answer, not a failure.',
        when: { kind: 'textPresent', text: { mode: 'contains', value: 'No records found' } },
        terminal: true,
        disposition: 'answer',
      },
      {
        name: 'ACCESS_DENIED',
        description: 'The service profile is not entitled to this record.',
        when: {
          kind: 'any',
          of: [
            { kind: 'httpStatusIn', statuses: [403] },
            { kind: 'textPresent', text: { mode: 'contains', value: 'Access denied' } },
          ],
        },
        terminal: true,
        disposition: 'needs_human',
      },
      {
        name: 'SESSION_EXPIRED',
        description: 'The console signed the service session out mid-flow.',
        when: { kind: 'textPresent', text: { mode: 'contains', value: 'session has expired' } },
        terminal: true,
        disposition: 'needs_human',
      },
      {
        name: 'CORE_UNAVAILABLE',
        description: 'The core returned an error page instead of a screen.',
        when: {
          kind: 'any',
          of: [
            { kind: 'httpStatusIn', statuses: [500, 502, 503] },
            { kind: 'textPresent', text: { mode: 'contains', value: 'An unexpected error occurred' } },
          ],
        },
        terminal: true,
        disposition: 'needs_human',
      },
    ],
    successCheckpoint: {
      kind: 'all',
      of: [
        { kind: 'textPresent', text: { mode: 'contains', value: 'Current Balance' } },
        { kind: 'textPresent', text: { mode: 'contains', value: 'Regular Savings' } },
      ],
    },
    policy: {
      allowedOrigins: ['{{baseUrl}}'],
      allowedRoutes: ['/', '/login', '/console', '/nav', '/content/*'],
      allowedActions: ['navigate', 'click', 'type', 'select', 'read', 'waitFor', 'pressKey'],
      maxRiskWithoutApproval: 'sensitive',
      maxSteps: 40,
      maxDurationMs: 120_000,
    },
    approval: { state: 'draft' },
    stability: { runs: 0, successes: 0, fallbackResolutions: 0 },
    tenantOverrides: {},
    provenance: {
      discoveredAt: '2026-09-09T00:00:00.000Z',
      discoveryRunId: 'fixture',
      model: 'fixture',
      promptVersion: 'fixture',
      humanEdits: [],
    },
    ...overrides,
  });
}
