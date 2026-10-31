import {
  useState,
  useEffect,
  useRef,
  useId,
  Children,
  isValidElement,
  cloneElement,
  type ReactElement,
  type ReactNode,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { X, Check, AlertCircle } from 'lucide-react';
import type { Character } from '../core/types';
export function Button({
  children,
  variant = 'default',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
}) {
  return (
    <button {...props} className={`button ${variant} ${className}`}>
      {children}
    </button>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  const generated = useId(),
    labelId = generated + '-label',
    hintId = generated + '-hint';
  type ControlProps = {
    id?: string;
    value?: unknown;
    'aria-label'?: string;
    'aria-labelledby'?: string;
    'aria-describedby'?: string;
  };
  const nodes = Children.toArray(children);
  const controlIndex = nodes.findIndex(
    (node) =>
      isValidElement(node) &&
      ('value' in (node.props as ControlProps) ||
        ['input', 'select', 'textarea'].includes(String(node.type))),
  );
  const control =
    controlIndex >= 0 ? (nodes[controlIndex] as ReactElement<ControlProps>) : undefined;
  const controlId = control?.props.id ?? generated;
  return (
    <div
      className="field"
      role={control ? undefined : 'group'}
      aria-labelledby={control ? undefined : labelId}
    >
      <label className="field-label" id={labelId} htmlFor={control ? controlId : undefined}>
        {label}
      </label>
      {nodes.map((node, index) =>
        index === controlIndex && isValidElement<ControlProps>(node)
          ? cloneElement(node, {
              id: controlId,
              ...(!node.props['aria-label'] ? { 'aria-labelledby': labelId } : {}),
              ...(hint ? { 'aria-describedby': hintId } : {}),
            })
          : node,
      )}
      {hint && <small id={hintId}>{hint}</small>}
    </div>
  );
}
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => (
  <input {...p} className={`input ${p.className ?? ''}`} />
);
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea {...p} className={`input textarea ${p.className ?? ''}`} />
);
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => (
  <select {...p} className={`input ${p.className ?? ''}`} />
);
export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="toggle-label">
      <span>{label}</span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
  side = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  side?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const panel = ref.current!;
    const focusable = () =>
      Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
        ),
      ).filter((el) => el.getClientRects().length);
    (focusable()[0] ?? panel).focus();
    const key = (event: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('[aria-modal="true"]');
      if (dialogs[dialogs.length - 1] !== panel) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        close.current();
      }
      if (event.key === 'Tab') {
        const items = focusable(),
          first = items[0],
          last = items.at(-1);
        if (!first) {
          event.preventDefault();
          return;
        }
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, []);
  return createPortal(
    <div
      className={`modal-backdrop ${side ? 'drawer-backdrop' : ''}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={ref}
        tabIndex={-1}
        className={`modal ${wide ? 'wide' : ''} ${side ? 'drawer' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button aria-label="关闭" className="icon-button" onClick={onClose}>
            <X size={22} />
          </button>
        </header>
        {children}
      </section>
    </div>,
    document.body,
  );
}
export function Confirm({
  title,
  children,
  onConfirm,
  onClose,
  confirmLabel = '确认恢复',
}: {
  title: string;
  children: ReactNode;
  onConfirm: () => void;
  onClose: () => void;
  confirmLabel?: string;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="confirm-body">{children}</div>
      <footer className="modal-actions">
        <Button onClick={onClose}>取消</Button>
        <Button variant="primary" onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </footer>
    </Modal>
  );
}
export const OPEN_CHARACTER_EVENT = 'aquarium:open-character';
export function Avatar({
  character,
  size = 44,
  quickEdit = true,
}: {
  character?: Partial<Character>;
  size?: number;
  /** Avatars open the character editor by default. Disable it inside the editor itself. */
  quickEdit?: boolean;
}) {
  const c = character;
  let hash = 0;
  for (const ch of c?.id ?? 'a') hash += ch.charCodeAt(0);
  const variant = hash % 3;
  const editable = quickEdit && !!c?.id;
  function open(event: React.MouseEvent<HTMLSpanElement>) {
    if (!editable || !c?.id) return;
    event.preventDefault();
    event.stopPropagation();
    window.dispatchEvent(new CustomEvent(OPEN_CHARACTER_EVENT, { detail: c.id }));
  }
  return (
    <span
      className={`avatar ${editable ? 'avatar-editable' : ''}`}
      style={{ width: size, height: size, background: c?.color ?? '#d7ddd5' }}
      {...(editable
        ? {
            role: 'button',
            tabIndex: 0,
            title: `编辑 ${c?.name ?? '角色'}`,
            'aria-label': `编辑 ${c?.name ?? '角色'} 的资料`,
            onClick: open,
            onKeyDown: (event: React.KeyboardEvent<HTMLSpanElement>) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                event.stopPropagation();
                if (c?.id)
                  window.dispatchEvent(new CustomEvent(OPEN_CHARACTER_EVENT, { detail: c.id }));
              }
            },
          }
        : {})}
    >
      {c?.avatar ? (
        <img
          src={c.avatar}
          alt={c.name ?? ''}
          style={c.avatarSource ? { objectPosition: '50% 12%' } : undefined}
        />
      ) : (
        <svg viewBox="0 0 120 140" role="img" aria-label={c?.name ?? '默认头像'}>
          <path
            d="M10 140q0-43 50-43t50 43"
            fill={variant === 0 ? '#313a43' : variant === 1 ? '#eee9da' : '#626e64'}
          />
          <path d="M46 87h28v27q-14 12-28 0" fill="#e8bd9c" />
          <ellipse cx="60" cy="60" rx="33" ry="43" fill="#f3d4b6" />
          <path
            d={
              variant === 0
                ? 'M24 77Q9 4 62 7q50 0 39 70l-14-25-4-24-23 27 1-22-27 26-5 30z'
                : variant === 1
                  ? 'M23 82Q5 2 65 6q55 4 33 89l-13-33-6-29-40 20-7 45z'
                  : 'M24 66Q6 8 56 6q55-4 46 65L86 40 65 33 36 54z'
            }
            fill={variant === 0 ? '#424950' : variant === 1 ? '#59463e' : '#e5e1d3'}
          />
          <path d="M40 67h10m20 0h10" stroke="#3a3534" strokeWidth="3" strokeLinecap="round" />
          <path d="M56 86q5 3 10-1" stroke="#ad7e6a" strokeWidth="2" fill="none" />
          {variant === 2 && (
            <g stroke="#696c63" strokeWidth="2" fill="none">
              <rect x="34" y="57" width="24" height="18" rx="6" />
              <rect x="65" y="57" width="24" height="18" rx="6" />
              <path d="M58 63h7" />
            </g>
          )}
          <path d="M44 110l16 15 17-15" stroke="#8b918b" strokeWidth="2" fill="none" />
        </svg>
      )}
    </span>
  );
}
export function Empty({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-symbol">◌</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {children}
    </div>
  );
}
export function Status({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return (
    <div className={`notice ${error ? 'error' : ''}`}>
      {error ? <AlertCircle size={17} /> : <Check size={17} />}
      <span>{children}</span>
    </div>
  );
}
export function useNotice() {
  const [notice, setNotice] = useState('');
  return { notice, setNotice };
}
export const fmtTime = (at: number, tz = 'Asia/Shanghai') =>
  new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(at);
export const fmtDate = (at: number, tz = 'Asia/Shanghai') =>
  new Intl.DateTimeFormat('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
    timeZone: tz,
  }).format(at);
