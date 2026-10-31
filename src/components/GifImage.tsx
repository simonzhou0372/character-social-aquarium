import { useEffect, useState, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../data/db';
export function GifImage({ assetId, autoplay = true }: { assetId: string; autoplay?: boolean }) {
  const asset = useLiveQuery(async () => {
    const a = await db.gifAssets.get(assetId);
    return a ? { asset: a, resource: await db.resources.get(a.resourceId) } : undefined;
  }, [assetId]);
  const [url, setUrl] = useState(''),
    [poster, setPoster] = useState(''),
    [ratio, setRatio] = useState('1'),
    [onScreen, setOnScreen] = useState(false);
  const element = useRef<HTMLImageElement>(null);
  useEffect(() => {
    if (!element.current) return;
    const observer = new IntersectionObserver(([entry]) => setOnScreen(entry.isIntersecting));
    observer.observe(element.current);
    return () => observer.disconnect();
  }, [url]);
  useEffect(() => {
    if (!asset?.resource) return;
    const url = URL.createObjectURL(asset.resource.blob);
    setUrl(url);
    const image = new Image();
    image.onload = () => {
      setRatio(`${image.naturalWidth}/${image.naturalHeight}`);
      const canvas = document.createElement('canvas');
      const ratio = Math.min(1, 256 / image.naturalWidth, 256 / image.naturalHeight);
      canvas.width = image.naturalWidth * ratio;
      canvas.height = image.naturalHeight * ratio;
      canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height);
      setPoster(canvas.toDataURL('image/png'));
      canvas.width = canvas.height = 0;
    };
    image.src = url;
    return () => {
      image.onload = null;
      image.src = '';
      URL.revokeObjectURL(url);
      setUrl('');
      setPoster('');
    };
  }, [asset?.resource?.id]);
  const reduce =
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!url) return <span>表情资源暂不可用</span>;
  return (
    <img
      ref={element}
      className="gif-image"
      loading="lazy"
      style={{ aspectRatio: ratio }}
      src={autoplay && !reduce && onScreen ? url : poster || undefined}
      alt={asset?.asset.name ?? 'GIF'}
    />
  );
}
