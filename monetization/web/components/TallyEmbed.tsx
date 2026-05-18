'use client';

import { useEffect, useState } from 'react';

export default function TallyEmbed({ src }: { src: string }) {
  const [height, setHeight] = useState(600);

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.data?.event === 'Tally.FormHeightChanged') {
        const h = e.data?.payload?.height;
        if (typeof h === 'number' && h > 50) setHeight(h + 24);
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return (
    <iframe
      src={src}
      width="100%"
      height={height}
      frameBorder="0"
      marginHeight={0}
      marginWidth={0}
      scrolling="no"
      title="Support form"
      style={{ background: 'transparent', display: 'block' }}
    />
  );
}
