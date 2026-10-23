import { useRef, useState, useEffect } from 'react';
import { Avatar, Button, Field, Input, Modal, Status } from './ui';
export function AvatarUpload({
  value,
  onChange,
  name = '你',
  cover = false,
}: {
  value?: string;
  onChange: (value: string) => void;
  name?: string;
  cover?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null),
    canvas = useRef<HTMLCanvasElement>(null);
  const [crop, setCrop] = useState(''),
    [zoom, setZoom] = useState(1),
    [error, setError] = useState(''),
    [ready, setReady] = useState(false);
  useEffect(() => {
    if (!crop) return;
    setReady(false);
    const image = new Image();
    image.onload = () => {
      const c = canvas.current;
      if (!c) return;
      const ctx = c.getContext('2d')!;
      c.width = cover ? 512 : 256;
      c.height = cover ? 288 : 256;
      const ratio = c.width / c.height;
      const width = Math.min(image.width, image.height * ratio) / zoom,
        height = width / ratio;
      ctx.drawImage(
        image,
        (image.width - width) / 2,
        (image.height - height) / 2,
        width,
        height,
        0,
        0,
        c.width,
        c.height,
      );
      setReady(true);
    };
    image.onerror = () => setError('无法解码图片，请更换文件');
    image.src = crop;
    return () => {
      image.onload = null;
      image.onerror = null;
    };
  }, [crop, zoom, cover]);
  useEffect(
    () => () => {
      if (crop) URL.revokeObjectURL(crop);
    },
    [crop],
  );
  async function choose(file?: File) {
    if (!file) return;
    setError('');
    if (
      !['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/bmp'].includes(
        file.type,
      ) ||
      file.size > 10 * 1024 * 1024 ||
      file.size === 0
    ) {
      setError('请选择 10 MB 以内的 PNG、JPEG、WebP、GIF、AVIF 或 BMP 图片');
      return;
    }
    const url = URL.createObjectURL(file),
      image = new Image();
    image.src = url;
    try {
      await image.decode();
      if (!image.naturalWidth || image.naturalWidth * image.naturalHeight > 40000000)
        throw new Error('图片尺寸过大');
      setZoom(1);
      setCrop(url);
    } catch {
      URL.revokeObjectURL(url);
      setError('图片无法解码或尺寸过大');
    }
  }
  return (
    <div
      className="avatar-upload"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void choose(e.dataTransfer.files[0]);
      }}
    >
      {cover && value ? (
        <img
          src={value}
          alt="封面预览"
          style={{ width: 160, aspectRatio: '16/9', objectFit: 'cover' }}
        />
      ) : (
        <Avatar character={{ name, avatar: value, color: '#e7e9df' }} size={72} />
      )}
      <Button onClick={() => input.current?.click()}>
        {cover ? '上传 / 更换封面' : '上传 / 更换头像'}
      </Button>
      <Button onClick={() => onChange('')}>{cover ? '恢复默认封面' : '恢复默认头像'}</Button>
      <small>也可以拖入图片；头像随本地备份保存。</small>
      <input
        ref={input}
        hidden
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp"
        onChange={(e) => {
          void choose(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {error && <Status error>{error}</Status>}
      {crop && (
        <Modal title={cover ? '裁剪封面' : '裁剪头像'} onClose={() => setCrop('')}>
          <canvas
            ref={canvas}
            width={256}
            height={256}
            style={{ width: 'min(100%,256px)', borderRadius: cover ? '8px' : '50%' }}
          />
          <Field label="缩放">
            <Input
              type="range"
              min="1"
              max="4"
              step="0.05"
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
            />
          </Field>
          <Button
            variant="primary"
            disabled={!ready}
            onClick={() => {
              if (canvas.current) {
                onChange(canvas.current.toDataURL('image/webp', 0.85));
                setCrop('');
              }
            }}
          >
            {cover ? '保存封面' : '保存头像'}
          </Button>
        </Modal>
      )}
    </div>
  );
}
