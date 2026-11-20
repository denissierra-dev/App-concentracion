import type { AppTheme, ThemePreference } from './types';

export interface ThemeOption {
  id: AppTheme;
  label: string;
  headerLabel: string;
  description: string;
  backendTheme: ThemePreference;
  swatchClass: string;
}

export const APP_THEMES: readonly ThemeOption[] = [
  {
    id: 'system',
    label: 'Sistema',
    headerLabel: 'Tema: Sistema',
    description: 'Adapta blanco/negro según el sistema operativo',
    backendTheme: 'system',
    swatchClass: 'theme-swatch-system',
  },
  {
    id: 'light',
    label: 'Blanco y Negro',
    headerLabel: 'Tema: Blanco y Negro',
    description: 'Acromática blanco dominante (contraste AAA)',
    backendTheme: 'light',
    swatchClass: 'theme-swatch-light',
  },
  {
    id: 'dark',
    label: 'Negro y Blanco',
    headerLabel: 'Tema: Negro y Blanco',
    description: 'Acromática negro dominante (modo oscuro)',
    backendTheme: 'dark',
    swatchClass: 'theme-swatch-dark',
  },
  {
    id: 'blue',
    label: 'Azul',
    headerLabel: 'Tema: Azul',
    description: 'Azul cobalto con acento naranja mandarina',
    backendTheme: 'light',
    swatchClass: 'theme-swatch-blue',
  },
  {
    id: 'purple',
    label: 'Morado',
    headerLabel: 'Tema: Morado',
    description: 'Púrpura real con acento amarillo limón',
    backendTheme: 'light',
    swatchClass: 'theme-swatch-purple',
  },
  {
    id: 'red',
    label: 'Roja',
    headerLabel: 'Tema: Roja',
    description: 'Rojo carmesí con acento verde menta',
    backendTheme: 'light',
    swatchClass: 'theme-swatch-red',
  },
  {
    id: 'orange',
    label: 'Naranja',
    headerLabel: 'Tema: Naranja',
    description: 'Naranja mandarina con acento azul cielo',
    backendTheme: 'light',
    swatchClass: 'theme-swatch-orange',
  },
  {
    id: 'green',
    label: 'Verde',
    headerLabel: 'Tema: Verde',
    description: 'Verde esmeralda con acento rojo coral',
    backendTheme: 'light',
    swatchClass: 'theme-swatch-green',
  },
] as const;

const THEME_BY_ID: Record<AppTheme, ThemeOption> = Object.fromEntries(
  APP_THEMES.map((item) => [item.id, item])
) as Record<AppTheme, ThemeOption>;

export function getThemeOption(theme: AppTheme): ThemeOption {
  return THEME_BY_ID[theme] ?? THEME_BY_ID.system;
}

export function toBackendTheme(theme: AppTheme): ThemePreference {
  return getThemeOption(theme).backendTheme;
}

export function isAppTheme(value: string): value is AppTheme {
  return Object.prototype.hasOwnProperty.call(THEME_BY_ID, value);
}
