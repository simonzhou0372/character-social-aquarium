import { createContext, useContext, type ReactNode } from 'react';

export type UIMode = 'game' | 'classic';
export type MotionLevel = 'off' | 'low' | 'standard' | 'high';

export interface UIPreferences {
  mode: UIMode;
  motion: MotionLevel;
}

const UIPreferencesContext = createContext<UIPreferences>({
  mode: 'game',
  motion: 'standard',
});

export function UIPreferencesProvider({
  value,
  children,
}: {
  value: UIPreferences;
  children: ReactNode;
}) {
  return <UIPreferencesContext.Provider value={value}>{children}</UIPreferencesContext.Provider>;
}

export function useUIPreferences() {
  return useContext(UIPreferencesContext);
}
