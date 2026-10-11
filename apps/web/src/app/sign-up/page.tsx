import Link from 'next/link';
import { ApiForm } from '../../components/api-form';

export default function SignUpPage() {
  return (
    <main>
      <h1>Create your account</h1>
      <ApiForm
        action="/api/v1/auth/sign-up"
        fields={[
          { name: 'name', label: 'Your name', type: 'text', autoComplete: 'name' },
          { name: 'email', label: 'Email', type: 'email', autoComplete: 'email' },
          {
            name: 'password',
            label: 'Password (at least 12 characters)',
            type: 'password',
            autoComplete: 'new-password',
          },
        ]}
        submitLabel="Sign up"
        successMessage="Check your inbox for a confirmation link."
      />
      <p>
        Already have an account? <Link href="/login">Log in</Link>
      </p>
    </main>
  );
}
