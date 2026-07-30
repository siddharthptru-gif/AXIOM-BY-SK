import { useEffect, useState } from 'react';
import type { BackdropMode } from '../lib/backdrop';

export const VIDEO_URLS: ReadonlyArray<string> = [
  'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260629_030107_874273ea-684a-4e90-bb96-8fdfde48d53d.mp4',
  'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260629_032424_3c9c2a9d-807b-4482-80e6-dd6d9dfd4545.mp4',
  'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260627_094019_4214ea73-b963-46a4-8327-61489192de99.mp4',
];

export function VideoBackdrop({ mode }: { mode: BackdropMode }) {
  const [sources, setSources] = useState<string[]>(() => [...VIDEO_URLS]);

  useEffect(() => {
    let cancelled = false;
    const objectUrls: string[] = [];

    const loadBlobs = async () => {
      const loadedSources = await Promise.all(
        VIDEO_URLS.map(async (url) => {
          try {
            const res = await fetch(url);
            if (!res.ok) return url;
            const blob = await res.blob();
            const objectUrl = URL.createObjectURL(blob);
            objectUrls.push(objectUrl);
            return objectUrl;
          } catch {
            return url;
          }
        }),
      );

      if (!cancelled) {
        setSources(loadedSources);
      }
    };

    loadBlobs();

    return () => {
      cancelled = true;
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  return (
    <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden bg-black">
      {sources.map((src, index) => {
        const isActive = mode === index;
        return (
          <video
            key={VIDEO_URLS[index]}
            src={src}
            autoPlay
            muted
            loop
            playsInline
            aria-hidden="true"
            className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-[1200ms] ease-in-out ${
              isActive ? 'opacity-100' : 'opacity-0'
            }`}
          />
        );
      })}

      {/* Overlay sitting above videos at z-[1] */}
      <div aria-hidden="true" className="absolute inset-0 z-[1] bg-black/10 pointer-events-none" />
    </div>
  );
}
