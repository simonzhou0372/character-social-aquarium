import { useState } from 'react';
import type { World, Character } from '../core/types';
import { TOUHOU_AS_OF, touhouSources } from '../data/presets/touhou-sources';
import { Input } from './ui';

export function PresetDetails({
  provenance,
  locations,
}: {
  provenance?: Character['provenance'];
  locations?: World['locationDetails'];
}) {
  const [query, setQuery] = useState('');
  if (!provenance) return null;
  return (
    <details className="panel preset-details">
      <summary>
        原设资料与出处 · {provenance.continuity === 'pc98' ? 'PC-98独立档案' : '东方Project'}
        {locations ? ` · ${locations.length} 处地点` : ''}
      </summary>
      <p>{provenance.note}</p>
      <p>用户编辑后的内容属于自定义版本，出处链接不为改写内容背书。</p>
      <p>
        整理日期：{TOUHOU_AS_OF}
        。以下列出原作出处；转录链接仅作为查阅入口，百科推测与同人设定不视为原作事实。
      </p>
      <ul>
        {provenance.sourceIds.map((id) => {
          const source = touhouSources[id];
          return source ? (
            <li key={id}>
              <a href={source.url} target="_blank" rel="noreferrer">
                {source.title}
              </a>
              <small>
                {' '}
                ·{' '}
                {
                  {
                    official: '官方页面',
                    'primary-transcript': '原作资料转录',
                    'work-index': '原作／章节索引',
                  }[source.kind]
                }{' '}
                · {source.original}
              </small>
            </li>
          ) : null;
        })}
      </ul>
      {locations && (
        <>
          <h3>地点与通行边界</h3>
          <Input
            aria-label="搜索原设地点"
            placeholder="搜索地点、区域或说明"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="preset-location-list">
            {locations
              .filter((p) => `${p.name}${p.region}${p.description}`.includes(query))
              .map((p) => (
                <article key={p.name}>
                  <strong>{p.name}</strong>
                  <span className="tag">
                    {p.region} ·{' '}
                    {
                      {
                        local: '当地活动范围',
                        restricted: '受限区域',
                        external: '外界／月面',
                        legacy: '旧作档案',
                      }[p.access]
                    }
                  </span>
                  <p>{p.description}</p>
                  <small>
                    出处：{p.sourceIds.map((id) => touhouSources[id]?.title ?? id).join('、')}
                  </small>
                </article>
              ))}
          </div>
        </>
      )}
      <p className="muted">
        关系数值、作息与观测历属于软件参数。角色的秘密不共享给所有人；之后生成的生活、对白与报告属于模拟记录，不是官方正史。
      </p>
    </details>
  );
}
