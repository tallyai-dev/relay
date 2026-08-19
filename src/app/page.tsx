import AuthGate from '@/components/AuthGate';
import RelayApp from '@/components/RelayApp';

export default function Page() {
  return (
    <AuthGate>
      <RelayApp />
    </AuthGate>
  );
}
