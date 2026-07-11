import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { listMyMessages } from '@/lib/api/growth';
import { queryKeys } from '@/lib/queryClient';
import { useAuth } from '@/auth/AuthProvider';

/** Header inbox icon with an unread count. Links to the message center. */
export function MessagesBell() {
  const { user } = useAuth();
  const userId = user?.id ?? '';

  const { data: messages } = useQuery({
    queryKey: queryKeys.myMessages(userId),
    queryFn: listMyMessages,
    enabled: userId !== '',
    staleTime: 60_000,
  });

  const unread = (messages ?? []).filter((m) => m.read_at === null).length;

  return (
    <Link
      to="/messages"
      aria-label={unread > 0 ? `Messages, ${unread} unread` : 'Messages'}
      className="relative rounded-md p-1.5 text-muted hover:bg-raised hover:text-app"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="size-5"
      >
        <path d="M4 5h16v12H7l-3 3z" />
      </svg>
      {unread > 0 && (
        <span className="absolute right-0.5 top-0.5 grid min-w-4 place-items-center rounded-full bg-flush-600 px-1 text-[0.6rem] font-bold text-white">
          {unread > 9 ? '9+' : unread}
        </span>
      )}
    </Link>
  );
}
