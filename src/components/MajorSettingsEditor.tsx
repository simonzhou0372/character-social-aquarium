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
  const s = value ?? defaultMajorSettings;
  return (
    <section className="panel">
      <h3>大型事件</h3>
      <Toggle
        label="启用大型事件"
        checked={s.enabled}
        onChange={(enabled) => onChange({ ...s, enabled })}
      />
      <Field label="最大发生间隔（虚拟日）">
        <Input
          type="number"
          min="1"
          max="36500"
          value={s.maximumIntervalDays}
          onChange={(e) => onChange({ ...s, maximumIntervalDays: Number(e.target.value) })}
        />
      </Field>
      <div className="toolbar">
        {[3, 7, 30, 90].map((n) => (
          <Button key={n} onClick={() => onChange({ ...s, maximumIntervalDays: n })}>
            {n} 天
          </Button>
        ))}
      </div>
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
        按虚拟时间保存截止期，暂停时停止倒计时。默认禁止死亡、永久失踪、删除团体等破坏性后果。
      </p>
    </section>
  );
}
