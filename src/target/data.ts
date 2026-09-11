/**
 * Fixture data for the demo back-office. Everything here is invented. The SSN
 * and date-of-birth fields exist specifically so the redaction layer has real
 * PII-shaped values to prove itself against — see src/policy/redactor.ts.
 */

export interface Account {
  readonly type: string;
  readonly number: string;
  readonly status: string;
  readonly balance: string;
}

export interface Member {
  readonly memberNumber: string;
  readonly name: string;
  readonly ssn: string;
  readonly dateOfBirth: string;
  readonly branch: string;
  /** When set, the detail screen renders a permission denial instead of data. */
  readonly restricted?: boolean;
  readonly accounts: readonly Account[];
}

export const MEMBERS: readonly Member[] = [
  {
    memberNumber: '10021',
    name: 'Dolores Vance',
    ssn: '412-55-9087',
    dateOfBirth: '1974-03-19',
    branch: 'Fremont Main',
    accounts: [
      { type: 'Regular Savings', number: 'S0001-10021', status: 'Open', balance: '$4,182.55' },
      { type: 'Free Checking', number: 'C0001-10021', status: 'Open', balance: '$912.30' },
    ],
  },
  {
    memberNumber: '10022',
    name: 'Marcus Ifill',
    ssn: '509-31-2264',
    dateOfBirth: '1961-11-02',
    branch: 'Alameda',
    accounts: [
      { type: 'Regular Savings', number: 'S0002-10022', status: 'Open', balance: '$58,004.12' },
      { type: 'Money Market', number: 'M0002-10022', status: 'Open', balance: '$12,000.00' },
      { type: 'Free Checking', number: 'C0002-10022', status: 'Dormant', balance: '$14.87' },
    ],
  },
  {
    memberNumber: '10023',
    name: 'Priya Raman',
    ssn: '221-08-7741',
    dateOfBirth: '1989-07-25',
    branch: 'Fremont Main',
    accounts: [
      { type: 'Regular Savings', number: 'S0003-10023', status: 'Open', balance: '$221.09' },
    ],
  },
  {
    memberNumber: '10024',
    name: 'Restricted Record',
    ssn: '000-00-0000',
    dateOfBirth: '1970-01-01',
    branch: 'Corporate',
    restricted: true,
    accounts: [],
  },
];

export function findMember(memberNumber: string): Member | undefined {
  const needle = memberNumber.trim();
  return MEMBERS.find((m) => m.memberNumber === needle);
}

export function searchMembers(query: string): readonly Member[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [];
  return MEMBERS.filter(
    (m) => m.memberNumber === needle || m.name.toLowerCase().includes(needle),
  );
}
