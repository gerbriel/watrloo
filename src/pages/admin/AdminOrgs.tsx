import type { FormEvent } from 'react';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { Business } from '@/types/db';
import { createOrg, deleteOrg, listOrgs, searchUsers, setOrgMember } from '@/lib/api/adminDirectory';
import type { DirectoryOrg } from '@/lib/api/adminDirectory';
import { getProfileByUsername } from '@/lib/api/profiles';
import { suspendBusiness } from '@/lib/api/growth';
import { updateBusinessProfile } from '@/lib/api/businesses';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { cn } from '@/lib/cn';

type OrgPatch = Partial<Pick<Business, 'name' | 'website' | 'logo_url' | 'slug'>>;

const ORGS_KEY = ['admin', 'orgs'] as const;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function fmt(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

/** Empty text fields map to NULL in the database, not an empty string. */
function norm(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function errMsg(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function SubscriptionChip({
  status,
  plan,
}: {
  status: string | null;
  plan: string | null;
}) {
  if (!status) {
    return (
      <span className="rounded-full bg-sunken px-2 py-0.5 text-xs font-medium text-muted">
        no plan
      </span>
    );
  }
  const tone =
    status === 'active'
      ? 'bg-green-500/15 text-green-500'
      : status === 'past_due'
        ? 'bg-amber-500/15 text-amber-500'
        : status === 'canceled'
          ? 'bg-red-500/15 text-red-500'
          : 'bg-sunken text-muted';
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', tone)}>
      {status}
      {plan ? ` · ${plan}` : ''}
    </span>
  );
}

function Stat({
  label,
  value,
  extra,
  warnWhenPositive = false,
}: {
  label: string;
  value: number;
  extra?: string;
  warnWhenPositive?: boolean;
}) {
  const warn = warnWhenPositive && value > 0;
  return (
    <div className="rounded-lg bg-sunken px-3 py-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold text-app">
        {warn ? (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-500">
            {value}
          </span>
        ) : (
          value
        )}
        {extra && (
          <span className="ml-1 text-xs font-normal text-muted">{extra}</span>
        )}
      </dd>
    </div>
  );
}

/**
 * Mounted only while a card is expanded, so each open starts from the org's
 * current values and collapse discards unsaved edits.
 */
function EditForm({
  org,
  onSaved,
  onCancel,
}: {
  org: DirectoryOrg;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(org.name);
  const [website, setWebsite] = useState(org.website ?? '');
  const [logoUrl, setLogoUrl] = useState(org.logo_url ?? '');
  const [slug, setSlug] = useState(org.slug ?? '');
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const [slugError, setSlugError] = useState<string | undefined>(undefined);

  const save = useMutation({
    mutationFn: (patch: OrgPatch) => updateBusinessProfile(org.id, patch),
    onSuccess: onSaved,
  });

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const nextName = name.trim();
    const nextSlug = norm(slug);
    let invalid = false;
    if (!nextName) {
      setNameError('Name is required.');
      invalid = true;
    } else {
      setNameError(undefined);
    }
    if (nextSlug && !SLUG_RE.test(nextSlug)) {
      setSlugError('Lowercase letters, numbers, and hyphens only.');
      invalid = true;
    } else {
      setSlugError(undefined);
    }
    if (invalid) return;

    const patch: OrgPatch = {};
    if (nextName !== org.name) patch.name = nextName;
    if (norm(website) !== org.website) patch.website = norm(website);
    if (norm(logoUrl) !== org.logo_url) patch.logo_url = norm(logoUrl);
    if (nextSlug !== org.slug) patch.slug = nextSlug;
    if (Object.keys(patch).length === 0) {
      onCancel(); // nothing changed — just collapse
      return;
    }
    save.mutate(patch);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 rounded-lg border border-app bg-surface p-3"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={nameError}
          maxLength={160}
        />
        <Input
          label="Website"
          type="url"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          placeholder="https://example.com"
          maxLength={300}
        />
        <Input
          label="Logo URL"
          type="url"
          value={logoUrl}
          onChange={(e) => setLogoUrl(e.target.value)}
          placeholder="https://example.com/logo.png"
          maxLength={500}
        />
        <Input
          label="Slug"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          error={slugError}
          hint="Lowercase letters, numbers, and hyphens — e.g. tims-cafe."
          maxLength={80}
        />
      </div>
      {save.isError && (
        <p role="alert" className="text-sm text-red-500">
          {errMsg(save.error, 'Could not save changes.')}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={save.isPending}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button type="submit" size="sm" loading={save.isPending}>
          Save changes
        </Button>
      </div>
    </form>
  );
}

function quickLink(to: string, label: string, title?: string) {
  return (
    <Link
      to={to}
      title={title}
      className="text-xs font-medium text-flush-600 hover:underline"
    >
      {label} →
    </Link>
  );
}

/** Admin member management: list via the admin user directory, mutate via
 *  the audited admin_set_org_member RPC. */
function MembersPanel({ org }: { org: DirectoryOrg }) {
  const qc = useQueryClient();
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<'owner' | 'manager' | 'staff'>('manager');
  const [msg, setMsg] = useState<string | null>(null);

  const members = useQuery({
    queryKey: ['admin', 'orgMembers', org.id],
    queryFn: () => searchUsers({ businessId: org.id, limit: 200 }),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['admin', 'orgMembers', org.id] });
    void qc.invalidateQueries({ queryKey: ORGS_KEY });
  };

  const mutate = useMutation({
    mutationFn: async ({
      userId,
      nextRole,
    }: {
      userId: string;
      nextRole: 'owner' | 'manager' | 'staff' | null;
    }) => setOrgMember(org.id, userId, nextRole),
    onSuccess: () => {
      setMsg(null);
      invalidate();
    },
    onError: (e) => setMsg(errMsg(e, 'Could not update membership.')),
  });

  async function addByUsername() {
    setMsg(null);
    const u = username.trim();
    if (!u) return;
    const profile = await getProfileByUsername(u).catch(() => null);
    if (!profile) {
      setMsg(`No account named @${u} — they need to sign up first, then add them here.`);
      return;
    }
    mutate.mutate({ userId: profile.id, nextRole: role });
    setUsername('');
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-app bg-surface p-3">
      <p className="text-sm font-medium text-app">Members</p>

      {members.isPending && <p className="text-sm text-muted">Loading members…</p>}
      {members.isError && (
        <p className="text-sm text-red-500">
          {errMsg(members.error, 'Could not load members.')}
        </p>
      )}
      {members.data && members.data.length === 0 && (
        <p className="text-sm text-muted">
          No members yet — this org is ownerless until you assign someone.
        </p>
      )}
      {members.data && members.data.length > 0 && (
        <ul className="flex flex-col gap-2">
          {members.data.map((m) => {
            const membership = m.businesses.find((b) => b.id === org.id);
            const busy = mutate.isPending && mutate.variables?.userId === m.user_id;
            return (
              <li key={m.user_id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm text-app">
                  <span className="font-medium">@{m.username}</span>{' '}
                  <span className="text-xs text-muted">· {membership?.role ?? '?'}</span>
                </span>
                <span className="flex items-center gap-1">
                  <select
                    value={membership?.role ?? 'staff'}
                    onChange={(e) =>
                      mutate.mutate({
                        userId: m.user_id,
                        nextRole: e.target.value as 'owner' | 'manager' | 'staff',
                      })
                    }
                    disabled={busy}
                    aria-label={`Role for @${m.username}`}
                    className="h-8 rounded-lg border border-app bg-surface px-2 text-xs text-app"
                  >
                    <option value="owner">owner</option>
                    <option value="manager">manager</option>
                    <option value="staff">staff</option>
                  </select>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-red-500 hover:bg-red-500/10"
                    loading={busy}
                    onClick={() => {
                      if (window.confirm(`Remove @${m.username} from ${org.name}?`)) {
                        mutate.mutate({ userId: m.user_id, nextRole: null });
                      }
                    }}
                  >
                    Remove
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-2 border-t border-app pt-3">
        <div className="min-w-40 flex-1">
          <Input
            label="Add by username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="username"
          />
        </div>
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as 'owner' | 'manager' | 'staff')}
          aria-label="Role for new member"
          className="h-10 rounded-lg border border-app bg-surface px-2 text-sm text-app"
        >
          <option value="owner">owner</option>
          <option value="manager">manager</option>
          <option value="staff">staff</option>
        </select>
        <Button
          variant="secondary"
          size="sm"
          loading={mutate.isPending}
          disabled={!username.trim()}
          onClick={() => void addByUsername()}
        >
          Add
        </Button>
      </div>
      {msg && <p className="text-sm text-red-500">{msg}</p>}
    </div>
  );
}

/** Create an org outright — for phone/email requests that never used the form. */
function NewOrgForm({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [website, setWebsite] = useState('');
  const [owner, setOwner] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);
    if (!name.trim()) {
      setError('Name is required.');
      return;
    }
    setBusy(true);
    try {
      let ownerId: string | undefined;
      if (owner.trim()) {
        const profile = await getProfileByUsername(owner.trim()).catch(() => null);
        if (!profile) {
          setError(
            `No account named @${owner.trim()} — they need to sign up first. ` +
              'You can create the org without an owner and assign them later.',
          );
          setBusy(false);
          return;
        }
        ownerId = profile.id;
      }
      await createOrg({ name: name.trim(), website: website.trim() || undefined, ownerId });
      setName('');
      setWebsite('');
      setOwner('');
      setOpen(false);
      onCreated();
    } catch (e: unknown) {
      setError(errMsg(e, 'Could not create the org.'));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)} className="w-fit">
        New org
      </Button>
    );
  }
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-app bg-raised p-4">
      <p className="text-sm font-medium text-app">Create an org</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={160} />
        <Input label="Website" type="url" value={website} onChange={(e) => setWebsite(e.target.value)} />
        <Input
          label="Owner username (optional)"
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
          hint="Leave blank to assign later."
        />
      </div>
      {error && <p className="text-sm text-red-500">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button size="sm" loading={busy} onClick={() => void submit()}>
          Create
        </Button>
      </div>
    </div>
  );
}

function OrgCard({
  org,
  suspendBusy,
  suspendError,
  onToggleSuspend,
}: {
  org: DirectoryOrg;
  suspendBusy: boolean;
  suspendError: string | null;
  onToggleSuspend: (org: DirectoryOrg) => void;
}) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const suspended = org.suspended_at != null;

  return (
    <li className="flex flex-col gap-3 rounded-xl border border-app bg-raised p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          {org.logo_url && (
            <img
              src={org.logo_url}
              alt=""
              loading="lazy"
              className="size-10 shrink-0 rounded-lg border border-app object-cover"
            />
          )}
          <div className="min-w-0">
            <p className="truncate font-semibold text-app">{org.name}</p>
            <p className="text-xs text-muted">
              {org.owner_username ? `@${org.owner_username}` : 'no owner'} · created{' '}
              {fmt(org.created_at)}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {suspended && (
            <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-500">
              Suspended
            </span>
          )}
          <SubscriptionChip
            status={org.subscription_status}
            plan={org.subscription_plan}
          />
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Members" value={org.member_count} />
        <Stat
          label="Verified claims"
          value={org.verified_claims}
          extra={org.pending_claims > 0 ? `· ${org.pending_claims} pending` : undefined}
        />
        <Stat label="Campaigns" value={org.campaign_count} />
        <Stat label="Open ad reports" value={org.open_reports} warnWhenPositive />
      </dl>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {quickLink('/admin/campaigns', 'Campaigns')}
        {quickLink('/admin/claims', 'Claims')}
        {quickLink(
          `/business/${org.id}/members`,
          'Members (roster)',
          'Rosters are member-visible only — if you are not a member this may appear empty.',
        )}
        {quickLink('/admin/users', 'Users in this org')}
      </div>

      {suspendError && (
        <p role="alert" className="text-sm text-red-500">
          {suspendError}
        </p>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? 'Close' : 'Edit'}
        </Button>
        {suspended ? (
          <Button
            variant="secondary"
            size="sm"
            loading={suspendBusy}
            onClick={() => onToggleSuspend(org)}
          >
            Unsuspend
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="text-red-500 hover:bg-red-500/10"
            loading={suspendBusy}
            onClick={() => onToggleSuspend(org)}
          >
            Suspend
          </Button>
        )}
      </div>

      {expanded && (
        <div className="flex flex-col gap-3">
          <EditForm
            org={org}
            onSaved={() => {
              void qc.invalidateQueries({ queryKey: ORGS_KEY });
              setExpanded(false);
            }}
            onCancel={() => setExpanded(false)}
          />
          <MembersPanel org={org} />
          <div className="flex justify-end">
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                if (
                  !window.confirm(
                    `PERMANENTLY delete ${org.name}? Members, subscription, claims, campaigns, and placements all go with it. This cannot be undone.`,
                  )
                )
                  return;
                if (window.prompt('Type DELETE to confirm') !== 'DELETE') return;
                const reason = window.prompt('Reason (optional):');
                if (reason === null) return;
                void deleteOrg(org.id, reason.trim() || undefined).then(() => {
                  void qc.invalidateQueries({ queryKey: ORGS_KEY });
                });
              }}
            >
              Delete org forever
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

export function AdminOrgs() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: [...ORGS_KEY, debounced],
    queryFn: () => listOrgs(debounced || undefined),
    placeholderData: (previous) => previous,
  });

  const toggle = useMutation({
    mutationFn: ({
      businessId,
      suspend,
      why,
    }: {
      businessId: string;
      suspend: boolean;
      why?: string;
    }) => suspendBusiness(businessId, suspend, why),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ORGS_KEY });
    },
  });

  function askToggleSuspend(org: DirectoryOrg) {
    if (org.suspended_at != null) {
      if (
        !window.confirm(
          `Unsuspend ${org.name}? Their promotions and console actions resume.`,
        )
      ) {
        return;
      }
      toggle.mutate({ businessId: org.id, suspend: false });
      return;
    }
    if (
      !window.confirm(
        `Suspend ${org.name}? This pauses all of their promotions and locks their console actions.`,
      )
    ) {
      return;
    }
    const why = window.prompt('Reason (written to the audit log):', '');
    if (why === null) return; // cancelled
    toggle.mutate({ businessId: org.id, suspend: true, why: why.trim() || undefined });
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-app">Manage orgs</h2>
        <p className="text-sm text-muted">
          Suspending an org pauses all its promotions and locks its console
          actions. Changes are audited.
        </p>
      </header>

      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search orgs by name…"
        aria-label="Search orgs by name"
        className="w-full max-w-sm rounded-lg border border-app bg-surface px-3 py-2 text-sm text-app placeholder:text-muted"
      />

      <NewOrgForm onCreated={() => void qc.invalidateQueries({ queryKey: ORGS_KEY })} />

      {isPending && <p className="text-sm text-muted">Loading orgs…</p>}

      {isError && (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-red-500">
            {errMsg(error, 'Could not load orgs.')}
          </p>
          <Button variant="secondary" size="sm" onClick={() => void refetch()}>
            Try again
          </Button>
        </div>
      )}

      {data && data.length === 0 && (
        <p className="text-sm text-muted">
          {debounced ? `No orgs matched “${debounced}”.` : 'No orgs yet.'}
        </p>
      )}

      {data && data.length > 0 && (
        <ul className="flex flex-col gap-3">
          {data.map((org) => (
            <OrgCard
              key={org.id}
              org={org}
              suspendBusy={toggle.isPending && toggle.variables?.businessId === org.id}
              suspendError={
                toggle.isError && toggle.variables?.businessId === org.id
                  ? errMsg(toggle.error, 'Could not update suspension.')
                  : null
              }
              onToggleSuspend={askToggleSuspend}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
