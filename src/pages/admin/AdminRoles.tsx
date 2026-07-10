import { useState } from 'react';
import { useAuth } from '@/auth/AuthProvider';
import { getProfileByUsername } from '@/lib/api/profiles';
import { getUserRoles, grantRole, revokeRole } from '@/lib/api/moderation';
import type { AppRole, Profile } from '@/types/db';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';

export function AdminRoles() {
  const { user } = useAuth();
  const [username, setUsername] = useState('');
  const [target, setTarget] = useState<Profile | null>(null);
  const [roles, setRoles] = useState<AppRole[]>([]);
  const [status, setStatus] = useState<'idle' | 'searching' | 'notfound'>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function find() {
    const u = username.trim();
    if (!u) return;
    setStatus('searching');
    setError(null);
    setTarget(null);
    try {
      const p = await getProfileByUsername(u);
      if (!p) {
        setStatus('notfound');
        return;
      }
      setTarget(p);
      setRoles(await getUserRoles(p.id));
      setStatus('idle');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Lookup failed.');
      setStatus('idle');
    }
  }

  async function change(action: 'grant' | 'revoke', role: AppRole) {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      if (action === 'grant') await grantRole(target.id, role);
      else await revokeRole(target.id, role);
      setRoles(await getUserRoles(target.id));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not change the role.');
    } finally {
      setBusy(false);
    }
  }

  const isSelf = target != null && target.id === user?.id;

  function RoleControl({ role }: { role: AppRole }) {
    const has = roles.includes(role);
    // Guard against an admin revoking their own admin and locking themselves out.
    const lockSelf = isSelf && role === 'admin' && has;
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-app bg-sunken px-3 py-2">
        <span className="text-sm text-app capitalize">
          {role}
          {has && <span className="ml-2 text-xs text-flush-600">· held</span>}
        </span>
        {has ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-red-500 hover:bg-red-500/10"
            disabled={busy || lockSelf}
            title={lockSelf ? "You can't revoke your own admin role" : undefined}
            onClick={() => void change('revoke', role)}
          >
            Revoke
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => void change('grant', role)}
          >
            Grant
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="flex max-w-lg flex-col gap-5">
      <div className="flex flex-col gap-2">
        <p className="text-sm text-muted">
          Look up a member by their exact username to grant or revoke roles.
          Moderators can triage reports and remove content; admins can also
          manage roles.
        </p>
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void find();
          }}
        >
          <Input
            label="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="username"
            className="flex-1"
          />
          <Button
            type="submit"
            variant="primary"
            size="md"
            loading={status === 'searching'}
          >
            Find
          </Button>
        </form>
        {status === 'notfound' && (
          <p className="text-sm text-red-500">No member with that username.</p>
        )}
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>

      {target && (
        <div className="flex flex-col gap-3 rounded-xl border border-app bg-raised p-4">
          <p className="text-sm font-medium text-app">
            @{target.username}
            {isSelf && <span className="ml-2 text-xs text-muted">(you)</span>}
          </p>
          <RoleControl role="moderator" />
          <RoleControl role="admin" />
        </div>
      )}
    </div>
  );
}
