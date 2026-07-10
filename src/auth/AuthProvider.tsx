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
import type { Profile } from '@/types/db';

/** Mirror of the DB check constraint on `profiles.username`. */
const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  /** True until the very first session check resolves. */
  loading: boolean;
  /**
   * Creates the account. When the project has email confirmation enabled
   * Supabase returns no session, so the caller must send the user to check
   * their inbox rather than treat them as signed in.
   */
  signUp: (
    email: string,
    password: string,
    username: string,
  ) => Promise<{ needsEmailConfirmation: boolean }>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Re-reads the profile row (e.g. after the user renames themselves). */
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
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
    async (email: string, password: string, username: string) => {
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
        options: { data: { username } },
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

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user,
      profile,
      loading,
      signUp,
      signIn,
      signOut,
      refreshProfile,
    }),
    [session, user, profile, loading, signUp, signIn, signOut, refreshProfile],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>.');
  return ctx;
}
