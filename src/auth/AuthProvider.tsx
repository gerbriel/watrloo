import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import type { AuthSession as Session, AuthUser as User } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import type { AppRole, BusinessMember, Profile } from '@/types/db';

/** Mirror of the DB check constraint on `profiles.username`. */
const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  /** Roles held by the signed-in user; empty for the base "user" tier. */
  roles: AppRole[];
  /** Convenience derivations: admin is a superset of moderator. */
  isModerator: boolean;
  isAdmin: boolean;
  /** Businesses the user belongs to (empty for ordinary users). */
  businessMemberships: BusinessMember[];
  isBusinessMember: boolean;
  /** True until the very first session check resolves. */
  loading: boolean;
  /** True while the signed-in user's roles are still being fetched. Role guards
   *  must wait on this, or they'd bounce a moderator before roles arrive. */
  rolesLoading: boolean;
  /**
   * Creates the account. Email confirmation is currently off, so Supabase
   * returns a live session and the caller signs the user straight in. The
   * needsEmailConfirmation flag stays in the contract so the check-your-email
   * flow still works if confirmation is ever turned back on.
   */
  signUp: (
    email: string,
    password: string,
    username: string,
    extras?: {
      firstName?: string;
      lastName?: string;
      phone?: string;
      termsAccepted?: boolean;
    },
  ) => Promise<{ needsEmailConfirmation: boolean }>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Emails a password-reset link that lands on /reset-password. */
  resetPassword: (email: string) => Promise<void>;
  /** Sets a new password for the current session (normal or recovery). */
  updatePassword: (newPassword: string) => Promise<void>;
  /** Re-reads the profile row (e.g. after the user renames themselves). */
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [roles, setRoles] = useState<AppRole[]>([]);
  const [rolesLoading, setRolesLoading] = useState(false);
  const [businessMemberships, setBusinessMemberships] = useState<BusinessMember[]>([]);
  const [loading, setLoading] = useState(true);

  const user = session?.user ?? null;
  const userId = user?.id ?? null;

  // Bootstrap the session, then keep it in sync. The listener MUST be torn down
  // on unmount, otherwise every Fast Refresh / StrictMode remount stacks another
  // subscription and we leak listeners.
  useEffect(() => {
    let active = true;

    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!active) return;
        setSession(data.session);
      })
      .catch(() => {
        // Offline, or auth is down. Treat it as "signed out" rather than leaving
        // `loading` true forever — otherwise every RequireAuth route spins
        // indefinitely and the public pages never render either.
        if (!active) return;
        setSession(null);
      })
      .finally(() => {
        // Only now do we know whether the user is signed in — flipping `loading`
        // here (not before) keeps RequireAuth from bouncing a logged-in user off
        // a deep link during the first render tick.
        if (active) setLoading(false);
      });

    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });

    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);

  // Load the profile whenever the signed-in user changes. A DB trigger mints
  // the row on signup, so we only ever read it here — never insert.
  useEffect(() => {
    if (!userId) {
      setProfile(null);
      return;
    }
    let active = true;
    supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!active) return;
        setProfile(error ? null : ((data as Profile | null) ?? null));
      });
    return () => {
      active = false;
    };
  }, [userId]);

  // Load the caller's roles alongside the profile. The "users read their own
  // roles" policy scopes this to their own rows, so it's safe to read directly.
  // This only gates what the UI *shows*; every privileged action is re-checked
  // in the database, so a tampered client gains nothing.
  useEffect(() => {
    if (!userId) {
      setRoles([]);
      setRolesLoading(false);
      return;
    }
    let active = true;
    setRolesLoading(true);
    supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', userId)
      .then(({ data, error }) => {
        if (!active) return;
        setRoles(error ? [] : ((data ?? []) as { role: AppRole }[]).map((r) => r.role));
        setRolesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [userId]);

  // Which businesses the user belongs to — gates the "For business" surfaces.
  // Read-only convenience; every business action is re-checked in the database.
  useEffect(() => {
    if (!userId) {
      setBusinessMemberships([]);
      return;
    }
    let active = true;
    supabase
      .from('business_members')
      .select('*')
      .eq('user_id', userId)
      .then(({ data, error }) => {
        if (!active) return;
        setBusinessMemberships(error ? [] : ((data ?? []) as BusinessMember[]));
      });
    return () => {
      active = false;
    };
  }, [userId]);

  const refreshProfile = useCallback(async () => {
    if (!userId) {
      setProfile(null);
      return;
    }
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle();
    if (!error) setProfile((data as Profile | null) ?? null);
  }, [userId]);

  const signUp = useCallback(
    async (
      email: string,
      password: string,
      username: string,
      extras?: {
        firstName?: string;
        lastName?: string;
        phone?: string;
        termsAccepted?: boolean;
      },
    ) => {
      // Validate against the same rule the DB enforces so the user gets a
      // friendly message instead of a raw constraint violation.
      if (!USERNAME_RE.test(username)) {
        throw new Error(
          'Username must be 3–30 characters, using only letters, numbers, and underscores.',
        );
      }
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          // The signup trigger reads these into profiles / profile_private /
          // user_consents — the name and phone never land in the public profile.
          // Marketing consent is off by default: local promos are contextual and
          // covered by the Terms, so there's nothing to opt into at signup.
          data: {
            username,
            first_name: extras?.firstName ?? '',
            last_name: extras?.lastName ?? '',
            phone: extras?.phone ?? '',
            marketing_opt_in: false,
            terms_accepted: extras?.termsAccepted === true ? 'true' : 'false',
          },
          // Fallback redirect if email confirmation is ever re-enabled. BASE_URL
          // carries the GitHub Pages '/watrloo/' prefix in prod and '/' in dev,
          // so this resolves to the deployed origin either way, and must be on
          // Supabase's redirect allowlist. detectSessionInUrl then reads the
          // returned session, so clicking the link lands them logged in on the app.
          emailRedirectTo: `${window.location.origin}${import.meta.env.BASE_URL}explore`,
        },
      });
      if (error) throw error;
      return { needsEmailConfirmation: data.session === null };
    },
    [],
  );

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  }, []);

  const signOut = useCallback(async () => {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  }, []);

  const resetPassword = useCallback(async (email: string) => {
    // Same BASE_URL treatment as emailRedirectTo above: '/watrloo/' on Pages,
    // '/' in dev. The URL must be on Supabase's redirect allowlist. Clicking
    // the link opens /reset-password with a recovery session already attached
    // (detectSessionInUrl), where updatePassword() completes the flow.
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}${import.meta.env.BASE_URL}reset-password`,
    });
    if (error) throw error;
  }, []);

  const updatePassword = useCallback(async (newPassword: string) => {
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) throw error;
  }, []);

  const isAdmin = roles.includes('admin');
  const isModerator = isAdmin || roles.includes('moderator');
  const isBusinessMember = businessMemberships.length > 0;

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user,
      profile,
      roles,
      isModerator,
      isAdmin,
      businessMemberships,
      isBusinessMember,
      loading,
      rolesLoading,
      signUp,
      signIn,
      signOut,
      resetPassword,
      updatePassword,
      refreshProfile,
    }),
    [
      session,
      user,
      profile,
      roles,
      isModerator,
      isAdmin,
      businessMemberships,
      isBusinessMember,
      loading,
      rolesLoading,
      signUp,
      signIn,
      signOut,
      resetPassword,
      updatePassword,
      refreshProfile,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>.');
  return ctx;
}
