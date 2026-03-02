interface FormatDateTimeOptions {
  fallback?: string;
  locale?: Intl.LocalesArgument;
  format?: Intl.DateTimeFormatOptions;
}

export function formatDateTime(
  value: string | null | undefined,
  options: FormatDateTimeOptions = {},
): string {
  const { fallback = 'n/a', locale, format } = options;
  if (!value) return fallback;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleString(locale, format);
}

export function formatNumber(value: number, locale?: Intl.LocalesArgument): string {
  return value.toLocaleString(locale);
}
