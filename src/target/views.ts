import type { TenantProfile } from './profiles.js';
import type { Member } from './data.js';
import { fieldName, type Session } from './session.js';

/**
 * Deliberately period-accurate markup: nested tables for layout, <font> tags,
 * spacer cells, no test ids, no ARIA, and labels that sit in an adjacent table
 * cell rather than in a <label for>. Several inputs therefore have no
 * accessible name at all, which is the case the perception layer's nearby-text
 * inference exists to solve.
 */

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function page(profile: TenantProfile, title: string, body: string): string {
  return `<html>
<head><title>${esc(profile.institution)} - ${esc(title)}</title></head>
<body bgcolor="#f4f4ef" text="#000000" link="#0033aa" vlink="#0033aa">
<table width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td bgcolor="${profile.accentColor}" height="26">
  <font face="Verdana,Arial" size="2" color="#ffffff">&nbsp;<b>${esc(profile.institution)}</b>
  &nbsp;&#183;&nbsp;Core Servicing ${esc(profile.productVersion)}</font>
</td></tr>
<tr><td height="6"><img src="/img/spacer.gif" width="1" height="6" border="0"></td></tr>
<tr><td>
<table width="100%" cellpadding="6" cellspacing="0" border="0"><tr><td>
<font face="Verdana,Arial" size="2">
${body}
</font>
</td></tr></table>
</td></tr>
</table>
</body></html>`;
}

export function loginPage(profile: TenantProfile, session: Session, error?: string): string {
  const banner = error
    ? `<table width="100%" cellpadding="4" cellspacing="0" border="0" bgcolor="#ffe8e8">
       <tr><td><font face="Verdana,Arial" size="2" color="#990000"><b>${esc(error)}</b></font></td></tr>
       </table><br>`
    : '';
  return page(
    profile,
    'Sign On',
    `${banner}
<form method="post" action="/login">
<table cellpadding="4" cellspacing="0" border="0">
<tr>
  <td align="right"><font face="Verdana,Arial" size="2">User ID</font></td>
  <td><input type="text" id="uid" name="${fieldName(session, 'user')}" size="18"></td>
</tr>
<tr>
  <td align="right"><font face="Verdana,Arial" size="2">Password</font></td>
  <td><input type="password" id="pwd" name="${fieldName(session, 'pass')}" size="18"></td>
</tr>
<tr><td></td><td><input type="submit" value="Sign On"></td></tr>
</table>
</form>
<br><font face="Verdana,Arial" size="1" color="#666666">
Demo environment. Credentials are fixtures and grant access to fabricated records only.
</font>`,
  );
}

export function framesetPage(profile: TenantProfile): string {
  return `<html>
<head><title>${esc(profile.institution)} - Core Servicing</title></head>
<frameset cols="180,*" border="1" frameborder="1">
  <frame name="navFrame" src="/nav">
  <frame name="mainFrame" src="/content/home">
</frameset>
</html>`;
}

const NAV_TARGETS: Record<string, string> = {
  Home: '/content/home',
  'Member Search': '/content/member-search',
  'Customer Search': '/content/member-search',
  Transactions: '/content/transactions',
  Reports: '/content/reports',
  'Sign Off': '/logout',
};

export function navFrame(profile: TenantProfile): string {
  const rows = profile.navOrder
    .map((label) => {
      const href = NAV_TARGETS[label] ?? '/content/home';
      const target = label === 'Sign Off' ? '_top' : 'mainFrame';
      return `<tr><td height="22">&nbsp;<font face="Verdana,Arial" size="2">
        <a href="${href}" target="${target}">${esc(label)}</a></font></td></tr>`;
    })
    .join('\n');
  return `<html><body bgcolor="#e4e4dc" text="#000000">
<table width="100%" cellpadding="2" cellspacing="0" border="0">
<tr><td bgcolor="${profile.accentColor}" height="20">&nbsp;<font face="Verdana,Arial" size="1" color="#ffffff"><b>MENU</b></font></td></tr>
${rows}
</table></body></html>`;
}

export function homeFrame(profile: TenantProfile, user: string): string {
  return page(
    profile,
    'Home',
    `<b>Signed on as ${esc(user)}</b><br><br>
Select a function from the menu on the left.<br><br>
<font size="1" color="#666666">Last core refresh 04:12 &#183; Batch window closed</font>`,
  );
}

export function searchForm(
  profile: TenantProfile,
  session: Session,
  message?: string,
): string {
  const banner = message
    ? `<table width="100%" cellpadding="4" cellspacing="0" border="0" bgcolor="#fff6d8">
       <tr><td><font face="Verdana,Arial" size="2"><b>${esc(message)}</b></font></td></tr>
       </table><br>`
    : '';
  // The input below has no id, no label element and no title. Its only
  // identifying context is the text in the cell to its left.
  return page(
    profile,
    `${profile.memberWord} Search`,
    `<b>${esc(profile.memberWord)} Search</b><br><br>
${banner}
<form method="post" action="/content/member-search">
<table cellpadding="4" cellspacing="0" border="0">
<tr>
  <td align="right"><font face="Verdana,Arial" size="2">${esc(profile.memberNumberLabel)}</font></td>
  <td><input type="text" name="${fieldName(session, 'q')}" size="14" maxlength="10"></td>
  <td><input type="submit" value="Search"></td>
</tr>
</table>
</form>`,
  );
}

export function searchResults(
  profile: TenantProfile,
  members: readonly Member[],
  query: string,
): string {
  if (members.length === 0) {
    return page(
      profile,
      `${profile.memberWord} Search`,
      `<b>${esc(profile.memberWord)} Search</b><br><br>
<table width="100%" cellpadding="4" cellspacing="0" border="0" bgcolor="#fff6d8">
<tr><td><font face="Verdana,Arial" size="2"><b>No records found for "${esc(query)}".</b></font></td></tr>
</table>
<br><a href="/content/member-search">Back to search</a>`,
    );
  }
  const rows = members
    .map(
      (m) => `<tr bgcolor="#ffffff">
  <td><font face="Verdana,Arial" size="2"><a href="/content/member/${esc(m.memberNumber)}">${esc(m.memberNumber)}</a></font></td>
  <td><font face="Verdana,Arial" size="2">${esc(m.name)}</font></td>
  <td><font face="Verdana,Arial" size="2">${esc(m.branch)}</font></td>
</tr>`,
    )
    .join('\n');
  return page(
    profile,
    `${profile.memberWord} Search`,
    `<b>${esc(profile.memberWord)} Search &#183; ${members.length} record(s)</b><br><br>
<table cellpadding="4" cellspacing="1" border="0" bgcolor="#c8c8c0">
<tr bgcolor="#e4e4dc">
  <td><font face="Verdana,Arial" size="2"><b>${esc(profile.memberNumberLabel)}</b></font></td>
  <td><font face="Verdana,Arial" size="2"><b>Name</b></font></td>
  <td><font face="Verdana,Arial" size="2"><b>Branch</b></font></td>
</tr>
${rows}
</table>
<br><a href="/content/member-search">Back to search</a>`,
  );
}

export function memberDetail(
  profile: TenantProfile,
  member: Member,
  tab: 'profile' | 'accounts',
): string {
  const tabs = `<table cellpadding="4" cellspacing="0" border="0"><tr>
<td bgcolor="${tab === 'profile' ? '#e4e4dc' : '#f4f4ef'}">
  <font face="Verdana,Arial" size="2"><a href="/content/member/${esc(member.memberNumber)}">Profile</a></font></td>
<td width="4"></td>
<td bgcolor="${tab === 'accounts' ? '#e4e4dc' : '#f4f4ef'}">
  <font face="Verdana,Arial" size="2"><a href="/content/member/${esc(member.memberNumber)}/accounts">Accounts</a></font></td>
</tr></table>`;

  const body =
    tab === 'profile'
      ? `<table cellpadding="3" cellspacing="0" border="0">
<tr><td align="right"><font face="Verdana,Arial" size="2">Name</font></td>
    <td><font face="Verdana,Arial" size="2"><b>${esc(member.name)}</b></font></td></tr>
<tr><td align="right"><font face="Verdana,Arial" size="2">${esc(profile.memberNumberLabel)}</font></td>
    <td><font face="Verdana,Arial" size="2">${esc(member.memberNumber)}</font></td></tr>
<tr><td align="right"><font face="Verdana,Arial" size="2">Date of Birth</font></td>
    <td><font face="Verdana,Arial" size="2">${esc(member.dateOfBirth)}</font></td></tr>
<tr><td align="right"><font face="Verdana,Arial" size="2">SSN</font></td>
    <td><font face="Verdana,Arial" size="2">${esc(member.ssn)}</font></td></tr>
<tr><td align="right"><font face="Verdana,Arial" size="2">Branch</font></td>
    <td><font face="Verdana,Arial" size="2">${esc(member.branch)}</font></td></tr>
</table>`
      : `<table cellpadding="4" cellspacing="1" border="0" bgcolor="#c8c8c0">
<tr bgcolor="#e4e4dc">
  <td><font face="Verdana,Arial" size="2"><b>Account Type</b></font></td>
  <td><font face="Verdana,Arial" size="2"><b>Account Number</b></font></td>
  <td><font face="Verdana,Arial" size="2"><b>Status</b></font></td>
  <td align="right"><font face="Verdana,Arial" size="2"><b>Current Balance</b></font></td>
</tr>
${member.accounts
  .map(
    (a) => `<tr bgcolor="#ffffff">
  <td><font face="Verdana,Arial" size="2">${esc(a.type)}</font></td>
  <td><font face="Verdana,Arial" size="2">${esc(a.number)}</font></td>
  <td><font face="Verdana,Arial" size="2">${esc(a.status)}</font></td>
  <td align="right"><font face="Verdana,Arial" size="2">${esc(a.balance)}</font></td>
</tr>`,
  )
  .join('\n')}
</table>
<br><a href="/content/member/${esc(member.memberNumber)}/new-subaccount">Open Sub-Account</a>`;

  return page(
    profile,
    `${profile.memberWord} ${member.memberNumber}`,
    `<b>${esc(profile.memberWord)} ${esc(member.memberNumber)} &#183; ${esc(member.name)}</b><br><br>
${tabs}
<table width="100%" cellpadding="8" cellspacing="0" border="0" bgcolor="#e4e4dc"><tr><td>
${body}
</td></tr></table>
<br><a href="/content/member-search">Back to search</a>`,
  );
}

export function permissionDenied(profile: TenantProfile, memberNumber: string): string {
  return page(
    profile,
    'Access Denied',
    `<table width="100%" cellpadding="6" cellspacing="0" border="0" bgcolor="#ffe8e8">
<tr><td><font face="Verdana,Arial" size="2" color="#990000">
<b>Access denied.</b> Your teller profile is not entitled to record ${esc(memberNumber)}.
Contact an operations supervisor for an entitlement override.
</font></td></tr></table>
<br><a href="/content/member-search">Back to search</a>`,
  );
}

export function interstitial(profile: TenantProfile, returnTo: string): string {
  return page(
    profile,
    'System Notice',
    `<table width="100%" cellpadding="6" cellspacing="0" border="0" bgcolor="#fff6d8">
<tr><td><font face="Verdana,Arial" size="2">
<b>System Notice</b><br><br>
A scheduled maintenance window begins tonight at 23:00 Pacific. Posting files
received after 22:30 will process on the next business day.
</font></td></tr></table>
<br>
<form method="get" action="${esc(returnTo)}">
<input type="submit" value="Acknowledge">
</form>`,
  );
}

export function sessionExpired(profile: TenantProfile): string {
  return page(
    profile,
    'Session Expired',
    `<table width="100%" cellpadding="6" cellspacing="0" border="0" bgcolor="#ffe8e8">
<tr><td><font face="Verdana,Arial" size="2" color="#990000">
<b>Your session has expired.</b> Sign on again to continue.
</font></td></tr></table>
<br><a href="/" target="_top">Return to sign on</a>`,
  );
}

export function serverError(profile: TenantProfile): string {
  return page(
    profile,
    'Unexpected Error',
    `<table width="100%" cellpadding="6" cellspacing="0" border="0" bgcolor="#ffe8e8">
<tr><td><font face="Verdana,Arial" size="2" color="#990000">
<b>An unexpected error occurred.</b> Reference CORE-500-7731.
</font></td></tr></table>`,
  );
}

export function newSubAccountForm(
  profile: TenantProfile,
  session: Session,
  member: Member,
  values: Record<string, string>,
  error?: string,
): string {
  const banner = error
    ? `<table width="100%" cellpadding="4" cellspacing="0" border="0" bgcolor="#ffe8e8">
       <tr><td><font face="Verdana,Arial" size="2" color="#990000"><b>${esc(error)}</b></font></td></tr>
       </table><br>`
    : '';
  return page(
    profile,
    'Open Sub-Account',
    `<b>Open Sub-Account &#183; ${esc(profile.memberWord)} ${esc(member.memberNumber)}</b><br><br>
${banner}
<form method="post" action="/content/member/${esc(member.memberNumber)}/new-subaccount">
<table cellpadding="4" cellspacing="0" border="0">
<tr>
  <td align="right"><font face="Verdana,Arial" size="2">Product Code</font></td>
  <td><select name="${fieldName(session, 'product')}">
    <option value="">-- select --</option>
    <option value="SAV02">SAV02 Holiday Club</option>
    <option value="SAV03">SAV03 Vacation Club</option>
    <option value="CD12">CD12 12-Month Certificate</option>
  </select></td>
</tr>
<tr>
  <td align="right"><font face="Verdana,Arial" size="2">Nickname</font></td>
  <td><input type="text" name="${fieldName(session, 'nickname')}" size="24"
      value="${esc(values.nickname ?? '')}"></td>
</tr>
<tr>
  <td align="right"><font face="Verdana,Arial" size="2">Opening Deposit</font></td>
  <td><input type="text" name="${fieldName(session, 'deposit')}" size="10"
      value="${esc(values.deposit ?? '')}"></td>
</tr>
<tr><td></td><td><input type="submit" value="Continue"></td></tr>
</table>
</form>
<br><a href="/content/member/${esc(member.memberNumber)}/accounts">Cancel</a>`,
  );
}

export function subAccountReview(
  profile: TenantProfile,
  member: Member,
  draft: Record<string, string>,
  token: string,
): string {
  const ack = profile.extraAcknowledgement
    ? `<tr><td colspan="2"><font face="Verdana,Arial" size="2">
       <input type="checkbox" name="ack" value="1"> I have verified the ${esc(
         profile.memberWord.toLowerCase(),
       )}'s identity per BSA policy.
       </font></td></tr>`
    : '';
  return page(
    profile,
    'Review Sub-Account',
    `<b>Review &#183; Open Sub-Account</b><br><br>
<table width="100%" cellpadding="8" cellspacing="0" border="0" bgcolor="#e4e4dc"><tr><td>
<table cellpadding="3" cellspacing="0" border="0">
<tr><td align="right"><font face="Verdana,Arial" size="2">${esc(profile.memberWord)}</font></td>
    <td><font face="Verdana,Arial" size="2">${esc(member.memberNumber)} ${esc(member.name)}</font></td></tr>
<tr><td align="right"><font face="Verdana,Arial" size="2">Product Code</font></td>
    <td><font face="Verdana,Arial" size="2">${esc(draft.product ?? '')}</font></td></tr>
<tr><td align="right"><font face="Verdana,Arial" size="2">Nickname</font></td>
    <td><font face="Verdana,Arial" size="2">${esc(draft.nickname ?? '')}</font></td></tr>
<tr><td align="right"><font face="Verdana,Arial" size="2">Opening Deposit</font></td>
    <td><font face="Verdana,Arial" size="2">${esc(draft.deposit ?? '')}</font></td></tr>
</table>
</td></tr></table>
<br>
<form method="post" action="/content/member/${esc(member.memberNumber)}/new-subaccount/confirm">
<input type="hidden" name="token" value="${esc(token)}">
<table cellpadding="4" cellspacing="0" border="0">
${ack}
<tr><td><input type="submit" value="Post Account"></td>
    <td><font face="Verdana,Arial" size="1" color="#990000">
    This posts to the core and cannot be reversed from this screen.</font></td></tr>
</table>
</form>
<br><a href="/content/member/${esc(member.memberNumber)}/new-subaccount">Back</a>`,
  );
}

export function subAccountConfirmed(
  profile: TenantProfile,
  member: Member,
  accountNumber: string,
): string {
  return page(
    profile,
    'Sub-Account Opened',
    `<table width="100%" cellpadding="6" cellspacing="0" border="0" bgcolor="#e8f4e8">
<tr><td><font face="Verdana,Arial" size="2">
<b>Sub-account opened.</b>
</font></td></tr></table>
<br>
<table cellpadding="3" cellspacing="0" border="0">
<tr><td align="right"><font face="Verdana,Arial" size="2">New Account Number</font></td>
    <td><font face="Verdana,Arial" size="2"><b>${esc(accountNumber)}</b></font></td></tr>
<tr><td align="right"><font face="Verdana,Arial" size="2">Confirmation</font></td>
    <td><font face="Verdana,Arial" size="2">${esc(`CONF-${accountNumber}`)}</font></td></tr>
</table>
<br><a href="/content/member/${esc(member.memberNumber)}/accounts">Return to accounts</a>`,
  );
}

export function simpleFrame(profile: TenantProfile, title: string, note: string): string {
  return page(profile, title, `<b>${esc(title)}</b><br><br>${esc(note)}`);
}
