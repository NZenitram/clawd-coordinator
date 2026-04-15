import { describe, it, expect, beforeEach } from 'vitest';
import { UserStore } from '../../src/coordinator/user-store.js';

describe('UserStore — Org management', () => {
  let store: UserStore;

  beforeEach(async () => {
    store = await UserStore.create(); // in-memory
  });

  // ── Org creation ─────────────────────────────────────────────────────────────

  it('creates an org and retrieves it by id', () => {
    const org = store.createOrg('acme');
    expect(org.id).toBeDefined();
    expect(org.name).toBe('acme');
    expect(org.createdAt).toBeGreaterThan(0);

    const fetched = store.getOrg(org.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe('acme');
  });

  it('retrieves an org by name', () => {
    const org = store.createOrg('globex');
    const fetched = store.getOrgByName('globex');
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(org.id);
  });

  it('returns null for unknown org id', () => {
    expect(store.getOrg('does-not-exist')).toBeNull();
  });

  it('returns null for unknown org name', () => {
    expect(store.getOrgByName('phantom')).toBeNull();
  });

  it('enforces org name uniqueness', () => {
    store.createOrg('unique-org');
    expect(() => store.createOrg('unique-org')).toThrow();
  });

  it('lists all orgs', () => {
    store.createOrg('org-a');
    store.createOrg('org-b');
    const orgs = store.listOrgs();
    expect(orgs.length).toBe(2);
    const names = orgs.map(o => o.name);
    expect(names).toContain('org-a');
    expect(names).toContain('org-b');
  });

  // ── Org membership ───────────────────────────────────────────────────────────

  it('adds a user as org member with default role', () => {
    const org = store.createOrg('springfield');
    const user = store.createUser('homer', 'operator');

    store.addOrgMember(org.id, user.id, 'operator');

    const memberships = store.getOrgMembership(user.id);
    expect(memberships).toHaveLength(1);
    expect(memberships[0].orgId).toBe(org.id);
    expect(memberships[0].role).toBe('operator');
  });

  it('adds an org admin member', () => {
    const org = store.createOrg('initech');
    const user = store.createUser('bill', 'operator');

    store.addOrgMember(org.id, user.id, 'admin');

    const membership = store.getUserOrg(user.id, org.id);
    expect(membership).not.toBeNull();
    expect(membership!.role).toBe('admin');
  });

  it('getUserOrg returns null when user is not a member', () => {
    const org = store.createOrg('umbrella');
    const user = store.createUser('alice', 'operator');

    expect(store.getUserOrg(user.id, org.id)).toBeNull();
  });

  it('removes an org member', () => {
    const org = store.createOrg('vandalay');
    const user = store.createUser('george', 'operator');

    store.addOrgMember(org.id, user.id, 'operator');
    expect(store.getOrgMembership(user.id)).toHaveLength(1);

    store.removeOrgMember(org.id, user.id);
    expect(store.getOrgMembership(user.id)).toHaveLength(0);
  });

  it('removeOrgMember is a no-op for non-existent membership', () => {
    const org = store.createOrg('pendant');
    const user = store.createUser('elaine', 'operator');
    // Should not throw
    expect(() => store.removeOrgMember(org.id, user.id)).not.toThrow();
  });

  it('user can belong to multiple orgs', () => {
    const orgA = store.createOrg('org-alpha');
    const orgB = store.createOrg('org-beta');
    const user = store.createUser('multi-user', 'operator');

    store.addOrgMember(orgA.id, user.id, 'operator');
    store.addOrgMember(orgB.id, user.id, 'viewer');

    const memberships = store.getOrgMembership(user.id);
    expect(memberships).toHaveLength(2);
    const orgIds = memberships.map(m => m.orgId);
    expect(orgIds).toContain(orgA.id);
    expect(orgIds).toContain(orgB.id);
  });

  it('addOrgMember with INSERT OR REPLACE updates role for existing member', () => {
    const org = store.createOrg('dunder-mifflin');
    const user = store.createUser('dwight', 'operator');

    store.addOrgMember(org.id, user.id, 'viewer');
    store.addOrgMember(org.id, user.id, 'admin'); // upsert

    const membership = store.getUserOrg(user.id, org.id);
    expect(membership!.role).toBe('admin');

    // Only one membership entry for this org
    const memberships = store.getOrgMembership(user.id);
    expect(memberships).toHaveLength(1);
  });

  it('listOrgMembers returns all members of an org', () => {
    const org = store.createOrg('pawnee');
    const u1 = store.createUser('leslie', 'operator');
    const u2 = store.createUser('ben', 'viewer');

    store.addOrgMember(org.id, u1.id, 'admin');
    store.addOrgMember(org.id, u2.id, 'operator');

    const members = store.listOrgMembers(org.id);
    expect(members).toHaveLength(2);
    const userIds = members.map(m => m.userId);
    expect(userIds).toContain(u1.id);
    expect(userIds).toContain(u2.id);
  });

  it('getOrgMembership returns empty array for user with no memberships', () => {
    const user = store.createUser('loner', 'operator');
    expect(store.getOrgMembership(user.id)).toHaveLength(0);
  });
});
