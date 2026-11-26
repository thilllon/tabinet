const DARK_CLASS = 'dark';
const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)';

/**
 * The class attribute `<html>` should carry for the given preference. Other classes are kept in
 * order (a stray second `dark` is collapsed). There is no theme setting: the page follows the OS.
 */
export function withDarkClass(className: string, dark: boolean): string {
  const classes = className.split(/\s+/).filter((name) => name !== '' && name !== DARK_CLASS);
  if (dark) {
    classes.push(DARK_CLASS);
  }
  return classes.join(' ');
}

/** Applies the OS colour scheme to `<html>` and keeps following it. */
export function followSystemTheme(): void {
  const root = document.documentElement;
  const apply = (dark: boolean): void => {
    root.className = withDarkClass(root.className, dark);
    root.style.colorScheme = dark ? 'dark' : 'light';
  };
  const media = window.matchMedia(DARK_MEDIA_QUERY);
  apply(media.matches);
  media.addEventListener('change', (event) => {
    apply(event.matches);
  });
}
