export type GraphNode = { id: string; name: string };
export type Box = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  lines: string[];
};
export type GraphLayout = {
  nodes: Box[];
  width: number;
  height: number;
  groups: { name: string; x: number; y: number; width: number; height: number }[];
};
const gap = 16;
function measure(n: GraphNode): Box {
  const chars = Array.from(n.name),
    lines: string[] = [];
  for (let i = 0; i < chars.length; i += 12) lines.push(chars.slice(i, i + 12).join(''));
  if (!lines.length) lines.push('未命名');
  return {
    id: n.id,
    x: 0,
    y: 0,
    width: Math.max(108, Math.min(208, chars.length * 15 + 28)),
    height: 70 + lines.length * 20,
    lines,
  };
}
/** Search bounded shelf widths; minimize occupied area with a small penalty for extreme aspect ratios. */
function compact(nodes: Box[]) {
  if (!nodes.length) return { nodes: [], width: 1, height: 1 };
  const sorted = [...nodes].sort(
    (a, b) => b.height - a.height || b.width - a.width || a.id.localeCompare(b.id),
  );
  const area = sorted.reduce((s, n) => s + (n.width + gap) * (n.height + gap), 0);
  const min = Math.max(...nodes.map((n) => n.width)) + gap * 2;
  let best: { nodes: Box[]; width: number; height: number; score: number } | undefined;
  for (let i = 0; i < 25; i++) {
    const target = Math.max(min, Math.sqrt(area) * (0.65 + i * 0.075));
    let x = gap,
      y = gap,
      row = 0,
      width = 0;
    const placed = sorted.map((n) => {
      if (x > gap && x + n.width + gap > target) {
        x = gap;
        y += row + gap;
        row = 0;
      }
      const box = { ...n, x, y };
      x += n.width + gap;
      row = Math.max(row, n.height);
      width = Math.max(width, x);
      return box;
    });
    const height = y + row + gap,
      score = width * height + 0.1 * Math.max(width, height) ** 2;
    if (!best || score < best.score) best = { nodes: placed, width, height, score };
  }
  return best!;
}
export function layoutGraph(
  nodes: GraphNode[],
  edges: { from: string; to: string }[],
  mode: 'compact' | 'readable',
  membership: Map<string, string> = new Map(),
): GraphLayout {
  const unique = [...new Map(nodes.map((n) => [n.id, n])).values()];
  if (mode === 'compact') return { ...compact(unique.map(measure)), groups: [] };
  const adjacency = new Map(unique.map((n) => [n.id, new Set<string>()]));
  for (const e of edges) {
    adjacency.get(e.from)?.add(e.to);
    adjacency.get(e.to)?.add(e.from);
  }
  // Unassigned nodes are clustered by connected component; group members never activate or duplicate others.
  const assignments = new Map(membership),
    seen = new Set<string>();
  let component = 0;
  for (const n of unique) {
    if (assignments.has(n.id) || seen.has(n.id)) continue;
    const label = `未分组 · ${++component}`,
      queue = [n.id];
    seen.add(n.id);
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      assignments.set(id, label);
      for (const next of adjacency.get(id) ?? [])
        if (adjacency.has(next) && !assignments.has(next) && !seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
    }
  }
  const buckets = new Map<string, Box[]>();
  for (const n of unique) {
    const k = assignments.get(n.id) ?? '未分组';
    buckets.set(k, [...(buckets.get(k) ?? []), measure(n)]);
  }
  const clusters = [...buckets]
    .map(([name, items]) => ({ name, layout: compact(items) }))
    .sort((a, b) => b.layout.nodes.length - a.layout.nodes.length || a.name.localeCompare(b.name));
  const containers = compact(
    clusters.map((g, i) => ({
      id: String(i),
      x: 0,
      y: 0,
      width: g.layout.width + 24,
      height: g.layout.height + 52,
      lines: [],
    })),
  );
  const placed: Box[] = [],
    groups: GraphLayout['groups'] = [];
  for (const box of containers.nodes) {
    const g = clusters[Number(box.id)];
    groups.push({ name: g.name, x: box.x, y: box.y, width: box.width, height: box.height });
    placed.push(...g.layout.nodes.map((n) => ({ ...n, x: n.x + box.x + 12, y: n.y + box.y + 40 })));
  }
  return { nodes: placed, width: containers.width, height: containers.height, groups };
}
