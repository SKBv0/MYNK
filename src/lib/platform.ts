/** Platform-dependent chrome labels; resolved once, since the platform cannot change at runtime. */

let cached: string | null = null;

const isApplePlatform = (): boolean => {
  const withData = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = withData.userAgentData?.platform ?? navigator.platform;
  return /mac|iphone|ipad/i.test(String(platform));
};

/** The shortcut modifier key as the user knows it: `⌘` on Apple hardware, `Ctrl` elsewhere. */
export const modifierKeyLabel = (): string => {
  if (cached === null) cached = isApplePlatform() ? '⌘' : 'Ctrl';
  return cached;
};
