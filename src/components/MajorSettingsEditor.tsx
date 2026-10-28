import { defaultMajorSettings } from '../core/major-events';
import type { World } from '../core/types';
import { Field, Input, Textarea, Toggle, Button } from './ui';
export function MajorSettingsEditor({
  value,
  onChange,
}: {
  value: World['majorEventSettings'];
  onChange: (s: NonNullable<World['majorEventSettings']>) => void;
}) {
  const s: NonNullable<World['majorEventSettings']> = value ?? defaultMajorSettings;
  return (
    <section className="panel">
      <h3>大型事件</h3>
      <Toggle
        label="启用大型事件"
        checked={s.enabled}
        onChange={(enabled) => onChange({ ...s, enabled })}
      />
      <Field label="重大事件目标/最大间隔（分钟）">
        <Input
          type="number"
          min="15"
          max="525600"
          value={s.intervalMinutes ?? Math.round(s.maximumIntervalDays * 1440)}
          onChange={(e) => {
            const minutes = Number(e.target.value);
            onChange({
              ...s,
              intervalMinutes: minutes,
              maximumIntervalDays: Math.max(0.01, minutes / 1440),
            });
          }}
        />
      </Field>
      <div className="toolbar">
        {[
          [1440, '24小时'],
          [720, '12小时'],
          [480, '8小时'],
          [360, '6小时'],
          [240, '4小时'],
          [120, '2小时'],
          [60, '1小时'],
        ].map(([minutes, label]) => (
          <Button
            key={minutes}
            onClick={() =>
              onChange({
                ...s,
                intervalMinutes: Number(minutes),
                maximumIntervalDays: Number(minutes) / 1440,
              })
            }
          >
            {label}
          </Button>
        ))}
      </div>
      <div className="toolbar">
        <Field label="每日上限">
          <Input
            type="number"
            min="1"
            max="48"
            value={s.maxPerDay ?? 10}
            onChange={(e) => onChange({ ...s, maxPerDay: Number(e.target.value) })}
          />
        </Field>
        <Field label="连锁深度">
          <Input
            type="number"
            min="0"
            max="3"
            value={s.maxChainDepth ?? 2}
            onChange={(e) => onChange({ ...s, maxChainDepth: Number(e.target.value) })}
          />
        </Field>
      </div>
      <Toggle
        label="允许因果连锁事件"
        checked={s.allowChainEvents !== false}
        onChange={(allowChainEvents) => onChange({ ...s, allowChainEvents })}
      />
      <Field label="大型事件倾向">
        <Textarea
          value={s.tendency}
          onChange={(e) => onChange({ ...s, tendency: e.target.value })}
        />
      </Field>
      <Toggle
        label="允许影响未锁定关系"
        checked={s.allowRelationshipChanges}
        onChange={(allowRelationshipChanges) => onChange({ ...s, allowRelationshipChanges })}
      />
      <Toggle
        label="允许影响多个团体"
        checked={s.allowMultipleGroups}
        onChange={(allowMultipleGroups) => onChange({ ...s, allowMultipleGroups })}
      />
      <p className="muted">
        按虚拟时间保存截止期，暂停时停止倒计时。间隔是目标/最大间隔，不是固定时刻；同一天可以发生多次。死亡、团体变化仍受小说模式与角色字段锁定约束。
      </p>
    </section>
  );
}
