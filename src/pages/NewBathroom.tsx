import { useNavigate } from 'react-router-dom';
import type { NewBathroom } from '@/types/db';
import { createBathroom } from '@/lib/api/bathrooms';
import { useAuth } from '@/auth/AuthProvider';
import { BathroomForm } from '@/components/bathroom/BathroomForm';

export function NewBathroomPage() {
  const navigate = useNavigate();
  const { user } = useAuth();

  async function handleSubmit(input: NewBathroom) {
    if (!user) throw new Error('You must be signed in to add a bathroom.');
    const created = await createBathroom(input, user.id);
    navigate(`/bathrooms/${created.id}`);
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-8">
      <header>
        <h1 className="text-2xl font-bold text-app">Add a bathroom</h1>
        <p className="text-sm text-muted">
          Put a public restroom on the map so others can find it.
        </p>
      </header>
      <BathroomForm onSubmit={handleSubmit} submitLabel="Add bathroom" />
    </div>
  );
}
