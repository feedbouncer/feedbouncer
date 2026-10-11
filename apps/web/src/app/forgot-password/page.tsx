import { ApiForm } from '../../components/api-form';

export default function ForgotPasswordPage() {
  return (
    <main>
      <h1>Reset your password</h1>
      <ApiForm
        action="/api/auth/request-password-reset"
        fields={[{ name: 'email', label: 'Email', type: 'email', autoComplete: 'email' }]}
        submitLabel="Send reset link"
        successMessage="If an account exists for that address, we sent a reset link."
      />
    </main>
  );
}
