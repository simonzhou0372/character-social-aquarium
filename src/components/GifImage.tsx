import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../data/db';
export function GifImage({ assetId, autoplay = true }: { assetId: string; autoplay?: boolean }) {
  const asset = useLiveQuery(async () => {
    const a = await db.gifAssets.get(assetId);
    return a ? { asset: a, resource: await db.resources.get(a.resourceId) } : undefined;
  }, [assetId]);
  const [url, setUrl] = useState(''),
    [poster, setPoster] = useState('');
  useEffect(() => {
    if (!asset?.resource) return;
    const url = URL.createObjectURL(asset.resource.blob);
    setUrl(url);
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      const ratio = Math.min(1, 256 / image.naturalWidth, 256 / image.naturalHeight);
      canvas.width = image.naturalWidth * ratio;
      canvas.height = image.naturalHeight * ratio;
      canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height);
      setPoster(canvas.toDataURL('image/png'));
    };
    image.src = url;
    return () => {
      image.onload = null;
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
      className="gif-image"
      loading="lazy"
      src={autoplay && !reduce ? url : poster || undefined}
      alt={asset?.asset.name ?? 'GIF'}
    />
  );
}
