'use client';

import { useEffect, useState } from 'react';
import type { EarlyBirdStatus } from '@/lib/pricing';

export default function EarlyBirdSpots({ initialData }: { initialData: EarlyBirdStatus }) {
  const [data, setData] = useState<EarlyBirdStatus>(initialData);

  useEffect(() => {
    const refresh = async () => {
      try {
        const res = await fetch('/api/early-bird');
        if (res.ok) setData(await res.json());
      } catch {}
    };

    const id = setInterval(refresh, 20_000);
    return () => clearInterval(id);
  }, []);

  if (!data.isEarlyBirdAvailable) {
    return (
      <p className="text-center text-xs font-medium mt-2" style={{ color: '#f87171' }}>
        Early adopter sold out
      </p>
    );
  }

  return (
    <p className="text-center text-xs font-medium mt-2" style={{ color: '#fbbf24' }}>
      Only {data.remaining} early adopter spot{data.remaining !== 1 ? 's' : ''} left
    </p>
  );
}
