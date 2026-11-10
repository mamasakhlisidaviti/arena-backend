export const LANGUAGES = ['ka', 'en', 'ru'] as const;
export type Language = (typeof LANGUAGES)[number];

export interface LocalizedString {
  ka: string;
  en: string;
  ru: string;
}

export interface LocalizedOption {
  value: string;
  label: LocalizedString;
}

export function pickLocalized(value: LocalizedString | undefined, language: Language): string {
  if (!value) {
    return '';
  }
  return value[language] || value.en || value.ka || value.ru || '';
}
