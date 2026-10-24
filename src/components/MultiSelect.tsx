import { useDeferredValue, useMemo, useState } from 'react';
import { Avatar, Button, Input } from './ui';
import type { Character } from '../core/types';
export type SelectionOption = {
  id: string;
  name: string;
  detail?: string;
  search?: string;
  disabled?: boolean;
  className?: string;
  character?: Partial<Character>;
};
export function selectionChange(
  selected: string[],
  ids: string[],
  action: 'all' | 'none' | 'invert',
) {
  const next = new Set(selected);
  for (const id of ids) {
    if (action === 'none' || (action === 'invert' && next.has(id))) next.delete(id);
    else next.add(id);
  }
  return [...next];
}
export function MultiSelect({
  options,
  value,
  onChange,
  label = '选择对象',
}: {
  options: SelectionOption[];
  value: string[];
  onChange: (ids: string[]) => void;
  label?: string;
}) {
  const [search, setSearch] = useState('');
  const query = useDeferredValue(search.trim().toLocaleLowerCase());
  const visible = useMemo(
    () =>
      options.filter((o) =>
        `${o.name} ${o.detail ?? ''} ${o.search ?? ''}`.toLocaleLowerCase().includes(query),
      ),
    [options, query],
  );
  const selected = new Set(value),
    available = visible.filter((o) => !o.disabled).map((o) => o.id);
  return (
    <section className="multi-select" role="region" aria-label={label}>
      <Input
        type="search"
        aria-label={`搜索${label}`}
        placeholder="搜索姓名、来源或团体…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="selection-tools">
        <strong>
          已选 {value.length} / {options.length}
        </strong>
        <Button onClick={() => onChange(selectionChange(value, available, 'all'))}>
          全选当前结果
        </Button>
        <Button onClick={() => onChange(selectionChange(value, available, 'none'))}>
          取消当前结果
        </Button>
        <Button onClick={() => onChange(selectionChange(value, available, 'invert'))}>
          反选当前结果
        </Button>
        <Button
          onClick={() =>
            onChange(
              selectionChange(
                value,
                options.filter((o) => !o.disabled).map((o) => o.id),
                'all',
              ),
            )
          }
        >
          全选全部
        </Button>
        <Button
          onClick={() => onChange(value.filter((id) => options.find((o) => o.id === id)?.disabled))}
        >
          清空选择
        </Button>
      </div>
      <div className="selection-grid">
        {visible.map((o) => (
          <label
            key={o.id}
            className={`${selected.has(o.id) ? 'selected' : ''} ${o.className ?? ''}`}
          >
            <input
              type="checkbox"
              aria-label={o.name}
              checked={selected.has(o.id)}
              disabled={o.disabled}
              onChange={() => onChange(selectionChange(value, [o.id], 'invert'))}
            />
            {o.character && <Avatar character={o.character} size={28} />}
            <span>
              <strong>{o.name}</strong>
              {o.detail && <small>{o.detail}</small>}
            </span>
          </label>
        ))}
      </div>
      {!visible.length && <p className="muted">没有匹配对象。已有选择保留。</p>}
      {value.some((id) => !visible.some((o) => o.id === id)) && (
        <small>部分已选对象不在当前结果中，确认时仍会保留。</small>
      )}
    </section>
  );
}
