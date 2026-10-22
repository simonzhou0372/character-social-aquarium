import { Field, Input } from './ui';
import { daysInMonth, type WorldDateTime } from '../core/calendar';
export function WorldDateEditor({
  value,
  onChange,
  label = '世界日期',
}: {
  value: WorldDateTime;
  onChange: (d: WorldDateTime) => void;
  label?: string;
}) {
  return (
    <fieldset className="world-date-editor">
      <legend>{label}</legend>
      <div className="form-grid">
        {(['year', 'month', 'day', 'hour', 'minute'] as const).map((key, i) => (
          <Field key={key} label={['年', '月', '日', '时', '分'][i]}>
            <Input
              type="number"
              min={key === 'hour' || key === 'minute' ? 0 : 1}
              max={
                key === 'year'
                  ? 999999
                  : key === 'month'
                    ? 12
                    : key === 'day'
                      ? daysInMonth(value.year, value.month)
                      : key === 'hour'
                        ? 23
                        : 59
              }
              value={value[key]}
              onChange={(e) => onChange({ ...value, [key]: Number(e.target.value) })}
            />
          </Field>
        ))}
      </div>
    </fieldset>
  );
}
