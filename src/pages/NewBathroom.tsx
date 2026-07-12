import { useNavigate } from 'react-router-dom';
import { createBathroom } from '@/lib/api/bathrooms';
import { setBathroomAttributes } from '@/lib/api/attributes';
import { useAuth } from '@/auth/AuthProvider';
import { BathroomForm } from '@/components/bathroom/BathroomForm';
import type { BathroomFormSubmit } from '@/components/bathroom/BathroomForm';

export function NewBathroomPage() {
  const navigate = useNavigate();
  const { user } = useAuth();

  async function handleSubmit({ bathroom, attributeSlugs }: BathroomFormSubmit) {
    if (!user) throw new Error('You must be signed in to add a bathroom.');
    const created = await createBathroom(bathroom, user.id);
    if (attributeSlugs.length > 0) {
      try {
        await setBathroomAttributes(created.id, attributeSlugs);
      } catch {
        // Non-fatal: the bathroom exists; attributes can be added later from
        // its page. Don't fail the whole flow over the tags.
      }
    }
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
