import { domainToUnicode } from 'node:url';

/**
 * Deterministic site-rule matching and explanation. Precedence is explicit so
 * the enforced rule and the explanation shown to people/agents never diverge.
 */
export const RULE_PRECEDENCE = Object.freeze([
  { id: 'security', description: 'Installed malicious-destination intelligence (security finding, not a preference). A human may proceed only with an explicit risk acknowledgement for that exact visit.' },
  { id: 'exact-visit', description: 'Human-approved exception for exactly one destination in one tab visit. It never covers redirects, other paths or other tabs and is not persisted.' },
  { id: 'block-connection', description: 'Enabled block rule in connection mode: stops navigations, frames and supported subresource/background requests.' },
  { id: 'block-navigation', description: 'Enabled block rule in navigation mode: stops top-level and frame navigations, redirects and popups.' },
  { id: 'warn', description: 'Enabled warn rule: the page loads and shows a warning.' },
]);
const classRank = rule => rule.behavior === 'block' ? (rule.mode === 'connection' ? 0 : 1) : 2;

export function ruleSource(rule) {
  if (rule.provenance?.kind === 'community-list') return 'community-list';
  return rule.scope === 'global' ? 'personal-global' : 'personal-workspace';
}

export function hostMatch(rule, hostname) {
  if (hostname === rule.hostname) return 'exact-hostname';
  if (rule.includeSubdomains && hostname.endsWith(`.${rule.hostname}`)) return 'subdomain';
  return null;
}

export function pathMatch(rule, pathname) {
  if (rule.path === '/') return 'any-path';
  if (pathname === rule.path) return 'exact-path';
  if (pathname.startsWith(`${rule.path.replace(/\/$/, '')}/`)) return 'path-prefix';
  return null;
}

export function hostnameDetails(hostname) {
  const unicode = domainToUnicode(hostname) || hostname;
  const punycode = hostname.split('.').some(label => label.startsWith('xn--'));
  const scripts = new Set();
  for (const char of unicode.replace(/[.\-\d]/g, '')) {
    if (/\p{Script=Latin}/u.test(char)) scripts.add('Latin');
    else if (/\p{Script=Cyrillic}/u.test(char)) scripts.add('Cyrillic');
    else if (/\p{Script=Greek}/u.test(char)) scripts.add('Greek');
    else if (/\p{Script=Han}/u.test(char)) scripts.add('Han');
    else if (/\p{Script=Arabic}/u.test(char)) scripts.add('Arabic');
    else if (/\p{Script=Hebrew}/u.test(char)) scripts.add('Hebrew');
    else scripts.add('Other');
  }
  return { ascii: hostname, unicode, punycode, scripts: [...scripts].sort(),
    mixedScript: scripts.size > 1, notice: punycode ? `Internationalized domain shown as ${unicode}; rules match the ASCII (punycode) form ${hostname}. Visually similar domains are different hosts.` : null };
}

export function reviewStatus(rule, today = new Date()) {
  if (!rule.reviewBy) return 'none';
  return rule.reviewBy < today.toISOString().slice(0, 10) ? 'due' : 'scheduled';
}

/** All rules (enabled and disabled) touching a URL, ordered by enforcement precedence. */
export function matchingRules(rules, value, workspaceId) {
  let url;
  try { url = new URL(value); } catch { return { url: null, matches: [] }; }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  const matches = [];
  for (const rule of rules) {
    if (rule.scope !== 'global' && rule.workspaceId !== workspaceId) continue;
    const host = hostMatch(rule, hostname);
    const path = host && pathMatch(rule, url.pathname);
    if (host && path) matches.push({ rule, host, path });
  }
  matches.sort((a, b) => (a.rule.enabled === false) - (b.rule.enabled === false)
    || classRank(a.rule) - classRank(b.rule)
    || (a.rule.scope === 'global') - (b.rule.scope === 'global')
    || (a.rule.provenance?.kind === 'community-list') - (b.rule.provenance?.kind === 'community-list')
    || b.rule.hostname.length - a.rule.hostname.length
    || b.rule.path.length - a.rule.path.length
    || String(a.rule.createdAt).localeCompare(String(b.rule.createdAt))
    || String(a.rule.id).localeCompare(String(b.rule.id)));
  return { url, hostname, matches };
}

export function effectiveRule(rules, value, workspaceId) {
  return matchingRules(rules, value, workspaceId).matches.find(match => match.rule.enabled !== false)?.rule ?? null;
}

/** Summary safe to return to agents: policy metadata, no unrelated rules. */
export function ruleSummary(rule) {
  return { id: rule.id, hostname: rule.hostname, includeSubdomains: rule.includeSubdomains, path: rule.path, behavior: rule.behavior,
    mode: rule.mode, scope: rule.scope, enabled: rule.enabled !== false, reason: rule.reason, note: rule.note || '', source: ruleSource(rule),
    kind: 'preference', evidence: rule.evidence ?? [], createdBy: rule.createdBy ?? (rule.provenance?.kind === 'community-list' ? 'community-list' : 'unknown'),
    createdAt: rule.createdAt, updatedAt: rule.updatedAt, revision: rule.revision, reviewBy: rule.reviewBy ?? null,
    lastReviewedAt: rule.lastReviewedAt ?? null, reviewStatus: reviewStatus(rule), provenance: rule.provenance ?? null };
}

export function explainRules(rules, value, workspaceId, { exception = null, security = [] } = {}) {
  const { url, hostname, matches } = matchingRules(rules, value, workspaceId);
  if (!url) throw new Error('Expected an absolute URL to explain');
  const enabled = matches.filter(match => match.rule.enabled !== false);
  const effective = enabled[0]?.rule ?? null;
  const ranked = matches.map((match, index) => ({ ...ruleSummary(match.rule), order: index + 1,
    precedence: match.rule.enabled === false ? 'disabled' : match.rule.behavior === 'block' ? `block-${match.rule.mode}` : 'warn',
    applies: match.rule.enabled !== false, effective: match.rule === effective, hostMatch: match.host, pathMatch: match.path,
    why: `${match.host === 'exact-hostname' ? `Hostname is ${match.rule.hostname}` : `Hostname is a subdomain of ${match.rule.hostname}`}; ${match.path === 'any-path' ? 'rule covers every path' : `path matches ${match.rule.path}`}.` }));
  const securityBlock = security.find(finding => finding.action === 'block');
  let decision = securityBlock ? 'block' : effective?.behavior === 'block' ? 'block' : effective?.behavior === 'warn' ? 'warn' : 'allow';
  let decidedBy = securityBlock ? 'security' : effective ? (effective.behavior === 'block' ? `block-${effective.mode}` : 'warn') : 'no-matching-rule';
  if (decision === 'block' && exception) { decision = 'allow-exception'; decidedBy = 'exact-visit'; }
  const conflicts = enabled.length > 1 && new Set(enabled.map(match => `${match.rule.behavior}:${match.rule.mode}`)).size > 1;
  return { url: url.href, hostname: hostnameDetails(hostname), decision, decidedBy,
    effectiveRuleId: effective?.id ?? null, matches: ranked, security, exception,
    conflicts: conflicts ? 'Several enabled rules with different effects match; the highest-precedence rule decides and the others remain listed.' : null,
    precedence: RULE_PRECEDENCE,
    limitations: ['Site rules govern requests made by this browser. External agents and other programs use their own networking and need their own enforcement.',
      'Matching uses the normalized ASCII hostname with domain-boundary checks, never substring matching. Related brands or businesses are not inferred.'] };
}
