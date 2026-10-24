import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Character, Relationship } from '../core/types';
import { layoutGraph } from '../core/graph-layout';
import { Button, Select, Status } from './ui';
type Camera = { x: number; y: number; zoom: number };
export function RelationshipGraph({
  characters,
  relations,
  groups,
  focus,
  onCharacter,
  onRelation,
}: {
  characters: Character[];
  relations: Relationship[];
  groups: Map<string, string>;
  focus: string;
  onCharacter: (c: Character) => void;
  onRelation: (r: Relationship) => void;
}) {
  const [mode, setMode] = useState<'compact' | 'readable'>('readable'),
    [camera, setCamera] = useState<Camera>({ x: 0, y: 0, zoom: 1 }),
    [size, setSize] = useState({ width: 900, height: 560 }),
    [notice, setNotice] = useState(''),
    [exporting, setExporting] = useState(false);
  const svg = useRef<SVGSVGElement>(null),
    viewport = useRef<HTMLDivElement>(null),
    pointers = useRef(new Map<number, { x: number; y: number }>()),
    moved = useRef(false),
    pressed = useRef<Element | null>(null),
    start = useRef({ x: 0, y: 0 });
  const marker = useId().replace(/:/g, ''),
    layout = useMemo(
      () => layoutGraph(characters, relations, mode, groups),
      [characters, relations, mode, groups],
    );
  const positions = new Map(layout.nodes.map((n) => [n.id, n]));
  const fit = () =>
    setCamera({
      x:
        (size.width -
          layout.width *
            Math.min((size.width - 24) / layout.width, (size.height - 24) / layout.height)) /
        2,
      y:
        (size.height -
          layout.height *
            Math.min((size.width - 24) / layout.width, (size.height - 24) / layout.height)) /
        2,
      zoom: Math.min((size.width - 24) / layout.width, (size.height - 24) / layout.height),
    });
  useEffect(() => {
    const o = new ResizeObserver(([r]) => setSize({ width: r.contentRect.width, height: 560 }));
    if (viewport.current) o.observe(viewport.current);
    return () => o.disconnect();
  }, []);
  const signature = layout.nodes
    .map((n) => `${n.id}:${n.x}:${n.y}:${n.width}:${n.height}`)
    .join('|');
  useEffect(() => {
    fit();
  }, [signature, size.width, mode]);
  function zoom(factor: number, x = size.width / 2, y = size.height / 2) {
    setCamera((c) => {
      const z = Math.max(0.005, Math.min(6, c.zoom * factor));
      return { zoom: z, x: x - ((x - c.x) * z) / c.zoom, y: y - ((y - c.y) * z) / c.zoom };
    });
  }
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoom(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [size.width]);
  async function download(format: 'svg' | 'png') {
    if (!svg.current) return;
    setExporting(true);
    setNotice('');
    let blobUrl = '';
    try {
      const copy = svg.current.cloneNode(true) as SVGSVGElement;
      copy.setAttribute(
        'style',
        `width:${layout.width}px;height:${layout.height}px;background:#fbfcf5`,
      );
      copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      copy.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
      copy.setAttribute('width', String(layout.width));
      copy.setAttribute('height', String(layout.height));
      copy.querySelector('[data-camera]')?.removeAttribute('transform');
      // Export the whole graph, not only the current viewport, and remove focus dimming.
      copy.querySelectorAll('[opacity]').forEach((e) => e.setAttribute('opacity', '1'));
      copy.querySelectorAll('[role="button"]').forEach((e) => {
        e.removeAttribute('role');
        e.removeAttribute('tabindex');
      });
      const data = new Blob([new XMLSerializer().serializeToString(copy)], {
        type: 'image/svg+xml;charset=utf-8',
      });
      let file: Blob = data;
      if (format === 'png') {
        blobUrl = URL.createObjectURL(data);
        const image = new Image();
        image.src = blobUrl;
        await image.decode();
        const scale = Math.min(
          2,
          8192 / layout.width,
          8192 / layout.height,
          Math.sqrt(24000000 / (layout.width * layout.height)),
        );
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.ceil(layout.width * scale));
        canvas.height = Math.max(1, Math.ceil(layout.height * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('浏览器不支持图片导出');
        ctx.fillStyle = '#fbfcf5';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        file = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('图片编码失败'))), 'image/png'),
        );
      }
      const url = URL.createObjectURL(file),
        a = document.createElement('a');
      a.href = url;
      a.download = `浮游-关系网-${mode}.${format}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      setNotice(
        format === 'svg'
          ? '已导出完整 SVG，可无损放大查看。'
          : '已导出完整 PNG；超大图限制画布大小，可用 SVG 保留全部细节。',
      );
    } catch (e) {
      setNotice(`导出失败：${String(e)}`);
    } finally {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      setExporting(false);
    }
  }
  return (
    <section className="relationship-graph" aria-label="可交互关系网络">
      <div className="toolbar graph-tools">
        <Select
          aria-label="关系网布局算法"
          value={mode}
          onChange={(e) => setMode(e.target.value as typeof mode)}
        >
          <option value="compact">紧凑排列 · 优先节省面积</option>
          <option value="readable">分组易读 · 优先直观</option>
        </Select>
        <Button onClick={() => zoom(1.3)} aria-label="放大关系网">
          ＋
        </Button>
        <Button onClick={() => zoom(1 / 1.3)} aria-label="缩小关系网">
          －
        </Button>
        <Button onClick={fit}>适应全部节点</Button>
        <span aria-live="polite">
          {Math.round(camera.zoom * 100)}% · {layout.nodes.length} 个节点
        </span>
        <Button disabled={exporting} onClick={() => void download('png')}>
          导出 PNG
        </Button>
        <Button disabled={exporting} onClick={() => void download('svg')}>
          导出 SVG
        </Button>
      </div>
      <p className="muted">
        拖动平移，滚轮或双指缩放。节点与姓名按实际占位留距；适应全图后可放大阅读，孤立角色也保留。分组为展示用途，不改变人物关系。点击人物或连线查看详情。
      </p>
      <div ref={viewport} className="graph-viewport">
        <svg
          ref={svg}
          viewBox={`0 0 ${size.width} ${size.height}`}
          style={{ width: '100%', height: 560, touchAction: 'none', background: '#fbfcf5' }}
          role="img"
          aria-label="有向人物关系图"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            const r = e.currentTarget.getBoundingClientRect();
            const p = { x: e.clientX - r.left, y: e.clientY - r.top };
            pointers.current.set(e.pointerId, p);
            start.current = p;
            moved.current = false;
            pressed.current = (e.target as Element).closest('[data-node],[data-edge]');
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const old = pointers.current.get(e.pointerId);
            if (!old) return;
            const r = e.currentTarget.getBoundingClientRect(),
              p = { x: e.clientX - r.left, y: e.clientY - r.top };
            const before = [...pointers.current.values()];
            pointers.current.set(e.pointerId, p);
            if (Math.hypot(p.x - start.current.x, p.y - start.current.y) > 4) moved.current = true;
            if (before.length === 1)
              setCamera((c) => ({ ...c, x: c.x + p.x - old.x, y: c.y + p.y - old.y }));
            else {
              moved.current = true;
              const after = [...pointers.current.values()];
              const distance = (a: typeof before) => Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
              const center = (a: typeof before) => ({
                x: (a[0].x + a[1].x) / 2,
                y: (a[0].y + a[1].y) / 2,
              });
              const b = center(before),
                a = center(after);
              setCamera((c) => {
                const z = Math.max(
                  0.005,
                  Math.min(6, (c.zoom * distance(after)) / Math.max(1, distance(before))),
                );
                return {
                  zoom: z,
                  x: a.x - ((b.x - c.x) * z) / c.zoom,
                  y: a.y - ((b.y - c.y) * z) / c.zoom,
                };
              });
            }
          }}
          onPointerUp={(e) => {
            const count = pointers.current.size;
            pointers.current.delete(e.pointerId);
            if (!moved.current && count === 1) {
              const n = pressed.current?.getAttribute('data-node'),
                r = pressed.current?.getAttribute('data-edge');
              if (n) {
                const c = characters.find((c) => c.id === n);
                if (c) onCharacter(c);
              }
              if (r) {
                const rel = relations.find((v) => v.id === r);
                if (rel) onRelation(rel);
              }
            }
            pressed.current = null;
          }}
          onPointerCancel={(e) => {
            pointers.current.delete(e.pointerId);
            pressed.current = null;
          }}
        >
          <defs>
            <marker
              id={marker}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto"
            >
              <path d="M0 0L10 5L0 10" fill="#758767" />
            </marker>
          </defs>
          <g
            data-camera="true"
            transform={`translate(${camera.x} ${camera.y}) scale(${camera.zoom})`}
            fontFamily="sans-serif"
          >
            <rect x="0" y="0" width={layout.width} height={layout.height} fill="#fbfcf5" />
            {layout.groups.map((g, i) => (
              <g key={i}>
                <rect
                  x={g.x}
                  y={g.y}
                  width={g.width}
                  height={g.height}
                  rx="14"
                  fill="#edf1e5"
                  stroke="#bdc9b2"
                />
                <text x={g.x + 14} y={g.y + 26} fontSize="14" fill="#526640">
                  {g.name}
                </text>
              </g>
            ))}
            {relations.map((r) => {
              const a = positions.get(r.from),
                b = positions.get(r.to);
              if (!a || !b) return null;
              const ax = a.x + a.width / 2,
                ay = a.y + a.height / 2,
                bx = b.x + b.width / 2,
                by = b.y + b.height / 2,
                offset = r.from < r.to ? 14 : -14,
                mx = (ax + bx) / 2 + offset,
                my = (ay + by) / 2 - offset;
              // Intersect each card with the curve tangent so arrowheads stay visible.
              const boundary = (
                cx: number,
                cy: number,
                tx: number,
                ty: number,
                w: number,
                h: number,
              ) => {
                const dx = tx - cx,
                  dy = ty - cy;
                const t = Math.min(
                  (w / 2 + 3) / (Math.abs(dx) || 1e-9),
                  (h / 2 + 3) / (Math.abs(dy) || 1e-9),
                );
                return { x: cx + dx * t, y: cy + dy * t };
              };
              const from = boundary(ax, ay, mx, my, a.width, a.height);
              const to = boundary(bx, by, mx, my, b.width, b.height);
              const path = `M${from.x} ${from.y}Q${mx} ${my} ${to.x} ${to.y}`;
              return (
                <g
                  data-edge={r.id}
                  key={r.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`${characters.find((c) => c.id === r.from)?.name} → ${characters.find((c) => c.id === r.to)?.name}：${r.label}`}
                  opacity={focus && r.from !== focus && r.to !== focus ? 0.15 : 0.7}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      e.stopPropagation();
                      onRelation(r);
                    }
                  }}
                >
                  <title>
                    {r.label} · 亲近 {r.closeness} / 信任 {r.trust} / 熟悉 {r.familiarity}
                  </title>
                  <path d={path} stroke="transparent" strokeWidth="14" fill="none" />
                  <path
                    d={path}
                    stroke="#7e9470"
                    strokeWidth="1.5"
                    fill="none"
                    markerEnd={`url(#${marker})`}
                  />
                </g>
              );
            })}
            {layout.nodes.map((n) => {
              const c = characters.find((c) => c.id === n.id)!;
              return (
                <g
                  data-node={n.id}
                  data-x={n.x}
                  data-y={n.y}
                  data-width={n.width}
                  data-height={n.height}
                  key={n.id}
                  role="button"
                  tabIndex={0}
                  aria-label={c.name}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      e.stopPropagation();
                      onCharacter(c);
                    }
                  }}
                  style={{ cursor: 'pointer' }}
                >
                  <rect
                    x={n.x}
                    y={n.y}
                    width={n.width}
                    height={n.height}
                    rx="12"
                    fill="#fffef8"
                    stroke={focus === n.id ? '#506c2f' : '#b4c3a4'}
                    strokeWidth={focus === n.id ? 3 : 1}
                  />
                  <circle cx={n.x + n.width / 2} cy={n.y + 30} r="22" fill={c.color} />
                  {c.avatar.startsWith('data:image/') ? (
                    <image
                      href={c.avatar}
                      x={n.x + n.width / 2 - 22}
                      y={n.y + 8}
                      width="44"
                      height="44"
                      preserveAspectRatio="xMidYMin slice"
                    />
                  ) : (
                    <text
                      x={n.x + n.width / 2}
                      y={n.y + 37}
                      textAnchor="middle"
                      fontSize="18"
                      fill="#263423"
                    >
                      {Array.from(c.name.replaceAll(' ', '')).slice(-2).join('')}
                    </text>
                  )}
                  {n.lines.map((line, i) => (
                    <text
                      key={i}
                      x={n.x + n.width / 2}
                      y={n.y + 72 + i * 20}
                      textAnchor="middle"
                      fontSize="14"
                      fill="#263423"
                    >
                      {line}
                    </text>
                  ))}
                </g>
              );
            })}
          </g>
        </svg>
      </div>
      {notice && <Status>{notice}</Status>}
    </section>
  );
}
