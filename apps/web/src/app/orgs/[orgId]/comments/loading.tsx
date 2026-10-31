import { LoadingPanel } from '../../../../components/states';

export default function Loading() {
  return (
    <main>
      <LoadingPanel label="Loading comments…" rows={6} />
    </main>
  );
}
