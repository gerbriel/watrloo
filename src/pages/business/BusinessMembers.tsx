import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { useAuth } from '@/auth/AuthProvider';
import {
  addMember,
  getProfileByUsername,
  listBusinessMembers,
  removeMember,
  type MemberWithProfile,
} from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';
import type { BusinessRole, Profile } from '@/types/db';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';

/** The roles an owner may hand out — owners are minted, never assigned here. */
type AddableRole = Exclude<BusinessRole, 'owner'>;

/**
 * Thrown when the typed username resolves to no profile, so the add form can
 * tell that apart from a genuine failure and show a gentle "no such user".
 */
class NoSuchUserError extends Error {}

/** Narrow a thrown value to a PostgREST/Postgres error carrying `code`. */
function hasCode(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === code
  );
}

function RoleChip({ role }: { role: BusinessRole }) {
  return (
    <span className="rounded-full border border-app bg-sunken px-2 py-0.5 text-xs font-medium capitalize text-muted">
      {role}
    </span>
  );
}

function MemberRow({
  member,
  canRemove,
  isSelf,
  busy,
  onRemove,
}: {
  member: MemberWithProfile;
  canRemove: boolean;
  isSelf: boolean;
  busy: boolean;
  onRemove: () => void;
}) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border border-app bg-raised px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-app">
          @{member.profile?.username ?? 'unknown'}
          {isSelf && <span className="ml-1 text-xs text-muted">(you)</span>}
        </span>
        <RoleChip role={member.role} />
      </div>
      {canRemove && (
        <Button
          variant="ghost"
          size="sm"
          className="text-red-500 hover:bg-red-500/10"
          loading={busy}
          onClick={onRemove}
        >
          Remove
        </Button>
      )}
    </li>
  );
}

export function BusinessMembers() {
  const { businessId } = useParams<{ businessId: string }>();
  const { user, businessMemberships } = useAuth();
  const qc = useQueryClient();

  const [username, setUsername] = useState('');
  const [role, setRole] = useState<AddableRole>('staff');

  // Only owners of *this* business get the management controls; everyone else
  // sees a read-only roster. The database re-checks this on every write.
  const isOwner = businessMemberships.some(
    (m) => m.business_id === businessId && m.role === 'owner',
  );

  const membersQuery = useQuery({
    queryKey: queryKeys.businessMembers(businessId ?? ''),
    queryFn: () => listBusinessMembers(businessId ?? ''),
    enabled: Boolean(businessId),
  });

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: queryKeys.businessMembers(businessId ?? '') });

  const addMut = useMutation({
    mutationFn: async () => {
      const profile: Profile | null = await getProfileByUsername(username.trim());
      if (!profile) throw new NoSuchUserError();
      await addMember(businessId ?? '', profile.id, role);
    },
    onSuccess: () => {
      setUsername('');
      void invalidate();
    },
  });

  const removeMut = useMutation({
    mutationFn: (userId: string) => removeMember(businessId ?? '', userId),
    onSuccess: () => void invalidate(),
  });

  const addMessage =
    addMut.error instanceof NoSuchUserError
      ? 'No user with that username.'
      : addMut.error instanceof Error
        ? addMut.error.message
        : null;

  const removeMessage = removeMut.error
    ? hasCode(removeMut.error, '23514')
      ? "You can't remove the last owner of a business."
      : removeMut.error instanceof Error
        ? removeMut.error.message
        : 'Could not remove that member.'
    : null;

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-xl font-semibold text-app">Team members</h1>
        <p className="mt-1 text-sm text-muted">
          {isOwner
            ? 'Add teammates by username and manage who can act for this business.'
            : 'People who can manage this business.'}
        </p>
      </header>

      {!businessId ? (
        <p className="text-sm text-red-500">No business selected.</p>
      ) : (
        <div className="flex flex-col gap-6">
          {isOwner && (
            <form
              className="flex flex-col gap-3 rounded-xl border border-app bg-raised p-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (username.trim()) addMut.mutate();
              }}
            >
              <div className="flex items-end gap-2">
                <Input
                  label="Username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="username"
                  className="flex-1"
                />
                <label className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium text-app">Role</span>
                  <select
                    value={role}
                    onChange={(e) => setRole(e.target.value as AddableRole)}
                    className="rounded-lg border border-app bg-surface px-3 py-2 text-app"
                  >
                    <option value="manager">Manager</option>
                    <option value="staff">Staff</option>
                  </select>
                </label>
                <Button
                  type="submit"
                  variant="primary"
                  size="md"
                  loading={addMut.isPending}
                  disabled={!username.trim()}
                >
                  Add
                </Button>
              </div>
              {addMessage && <p className="text-sm text-red-500">{addMessage}</p>}
            </form>
          )}

          {membersQuery.isPending ? (
            <p className="text-sm text-muted">Loading members…</p>
          ) : membersQuery.isError ? (
            <div className="flex flex-col items-start gap-2">
              <p className="text-sm text-red-500">
                {membersQuery.error instanceof Error
                  ? membersQuery.error.message
                  : 'Could not load members.'}
              </p>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void membersQuery.refetch()}
              >
                Try again
              </Button>
            </div>
          ) : membersQuery.data.length === 0 ? (
            <div className="rounded-xl border border-app bg-raised p-8 text-center">
              <p className="font-medium text-app">No members yet</p>
              <p className="mt-1 text-sm text-muted">
                {isOwner ? 'Add your first teammate above.' : 'This team is empty.'}
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {membersQuery.data.map((member) => (
                <MemberRow
                  key={member.user_id}
                  member={member}
                  canRemove={isOwner && member.user_id !== user?.id}
                  isSelf={member.user_id === user?.id}
                  busy={removeMut.isPending && removeMut.variables === member.user_id}
                  onRemove={() => removeMut.mutate(member.user_id)}
                />
              ))}
            </ul>
          )}

          {removeMessage && <p className="text-sm text-red-500">{removeMessage}</p>}
        </div>
      )}
    </div>
  );
}
