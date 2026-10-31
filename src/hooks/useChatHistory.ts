import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useVirtualizer } from '@tanstack/react-virtual';
import { db } from '../data/db';
import {
  CHAT_WINDOW,
  messageAround,
  messageKey,
  messagePage,
  type MessageKey,
} from '../data/chat-history';
const positions = new Map<string, { id: string; offset: number }>();
export function useChatHistory(id: string, feed: RefObject<HTMLDivElement>, paused: boolean) {
  const [query, setQuery] = useState<{
    owner: string;
    target?: string;
    key?: MessageKey;
    direction: 'before' | 'after';
  }>({ owner: id, direction: 'before' });
  const [following, setFollowing] = useState(true);
  const anchor = useRef<{ id: string; offset: number }>();
  const jumping = useRef<string>();
  const loading = useRef(false);
  const restoring = useRef(false);
  const generation = useRef(0);
  const result = useLiveQuery(async () => {
    if (query.owner !== id) return { owner: id, rows: [] };
    let rows = query.target
      ? await messageAround(id, query.target)
      : await messagePage(id, query.direction, query.key, query.key ? CHAT_WINDOW : 40);
    if (query.target && !rows.length) rows = await messagePage(id, 'before', query.key, 40);
    return { owner: id, rows };
  }, [id, query]);
  const rows = result?.owner === id && query.owner === id ? result.rows : [];
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => feed.current,
    estimateSize: () => 120,
    getItemKey: (i) => rows[i].id,
    overscan: 5,
  });
  function capture() {
    const el = feed.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top;
    const nodes = [...el.querySelectorAll<HTMLElement>('[data-message-id]')];
    const node = nodes.find(
      (node) =>
        (node.closest<HTMLElement>('[data-index]') ?? node).getBoundingClientRect().bottom > top,
    );
    if (!node) return;
    const wrapper = node.closest<HTMLElement>('[data-index]') ?? node;
    return { id: node.dataset.messageId!, offset: top - wrapper.getBoundingClientRect().top };
  }
  useEffect(() => {
    generation.current++;
    const saved = positions.get(id);
    anchor.current = saved;
    setFollowing(!saved);
    setQuery({ owner: id, direction: 'before', target: saved?.id });
    return () => {
      generation.current++;
      loading.current = false;
    };
  }, [id]);
  useEffect(() => {
    if (!paused) return;
    const a = capture();
    if (a) {
      anchor.current = a;
      setFollowing(false);
      setQuery({ owner: id, direction: 'before', target: a.id });
    }
  }, [paused]);
  useLayoutEffect(() => {
    if (!rows.length) return;
    const keep = new Set(rows.map((m) => m.id));
    for (const key of virtual.itemSizeCache.keys())
      if (!keep.has(String(key))) virtual.itemSizeCache.delete(key);
    const a = anchor.current ?? (!following || paused ? positions.get(id) : undefined);
    const target = jumping.current ?? a?.id;
    const i = rows.findIndex((m) => m.id === target);
    let frame = 0;
    if (i >= 0) {
      restoring.current = true;
      virtual.scrollToIndex(i, { align: 'start' });
      const desiredOffset = jumping.current ? 0 : (a?.offset ?? 0);
      let attempts = 0;
      const restore = () => {
        const el = feed.current;
        const node = el?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(target!)}"]`);
        const wrapper = node?.closest<HTMLElement>('[data-index]');
        if (el && wrapper) {
          const delta =
            wrapper.getBoundingClientRect().top - el.getBoundingClientRect().top + desiredOffset;
          if (Math.abs(delta) > 0.5) el.scrollTop += delta;
        }
        if (++attempts < 6) frame = requestAnimationFrame(restore);
        else {
          restoring.current = false;
          const saved = capture();
          if (saved) {
            positions.delete(id);
            positions.set(id, saved);
            if (positions.size > 30) positions.delete(positions.keys().next().value!);
          }
        }
      };
      frame = requestAnimationFrame(restore);
    } else if (following && !paused) virtual.scrollToIndex(rows.length - 1, { align: 'end' });
    anchor.current = undefined;
    jumping.current = undefined;
    loading.current = false;
    return () => {
      cancelAnimationFrame(frame);
      restoring.current = false;
    };
  }, [result]);
  async function jump(target: string) {
    const token = ++generation.current;
    loading.current = false;
    const m = await db.messages.get(target);
    if (token !== generation.current || !m || m.conversationId !== id) return false;
    jumping.current = target;
    setFollowing(false);
    setQuery({ owner: id, direction: 'before', target, key: messageKey(m) });
    return true;
  }
  function latest() {
    generation.current++;
    loading.current = false;
    anchor.current = undefined;
    jumping.current = undefined;
    setFollowing(true);
    setQuery({ owner: id, direction: 'before' });
  }
  async function onScroll() {
    const el = feed.current;
    if (!el || !rows.length || restoring.current) return;
    const a = capture();
    if (a) {
      positions.delete(id);
      positions.set(id, a);
      if (positions.size > 30) positions.delete(positions.keys().next().value!);
    }
    if (loading.current) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (!nearBottom) {
      setFollowing(false);
      if (!query.key && !query.target && el.scrollTop >= 160) {
        loading.current = true;
        anchor.current = a;
        const token = generation.current;
        const before = await messagePage(id, 'before', messageKey(rows[0]), 1);
        if (token === generation.current)
          setQuery({
            owner: id,
            direction: 'after',
            key: before[0] ? messageKey(before[0]) : [id, -Infinity, ''],
          });
        return;
      }
    }
    const direction = el.scrollTop < 160 ? 'before' : nearBottom ? 'after' : undefined;
    if (!direction) return;
    loading.current = true;
    const token = generation.current;
    const edge = direction === 'before' ? rows[0] : rows.at(-1)!;
    const page = await messagePage(id, direction, messageKey(edge), 40);
    if (token !== generation.current) return;
    if (page.length) {
      anchor.current = capture();
      // Shift by one page while retaining the reading anchor and a bounded overlap.
      const key =
        direction === 'before'
          ? messageKey(page[0])
          : messageKey(rows[Math.max(0, rows.length - 120)]);
      const preceding = await messagePage(id, 'before', key, 1);
      if (token === generation.current)
        setQuery({
          owner: id,
          direction: 'after',
          key: preceding[0] ? messageKey(preceding[0]) : [id, -Infinity, ''],
        });
    } else {
      loading.current = false;
      if (nearBottom && !paused) {
        setFollowing(true);
        if (query.key || query.target) latest();
      }
    }
  }
  return { rows, virtual, jump, latest, onScroll, following };
}
