/**
 * Bound to the design tokens in index.css; scales are replaced, not extended, so ad-hoc
 * values have no token to hide behind.
 * @type {import('tailwindcss').Config}
 */
const withAlpha = (name) => `rgb(var(--${name}-rgb) / <alpha-value>)`;

module.exports = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    borderRadius: {
      none: '0',
      sm: 'var(--radius-sm)',
      DEFAULT: 'var(--radius-sm)',
      md: 'var(--radius-md)',
      lg: 'var(--radius-lg)',
      full: 'var(--radius-full)',
    },
    fontSize: {
      xs: ['var(--text-xs)', { lineHeight: '16px' }],
      sm: ['var(--text-sm)', { lineHeight: '18px' }],
      base: ['var(--text-base)', { lineHeight: '22px' }],
      md: ['var(--text-md)', { lineHeight: '24px' }],
      lg: ['var(--text-lg)', { lineHeight: '28px' }],
      xl: ['var(--text-xl)', { lineHeight: '36px' }],
    },
    fontFamily: {
      sans: 'var(--font-body)',
      display: 'var(--font-display)',
      mono: 'var(--font-mono)',
    },
    fontWeight: {
      normal: '400',
      medium: '500',
      semibold: '600',
      bold: '700',
    },
    boxShadow: {
      sm: 'var(--shadow-sm)',
      md: 'var(--shadow-md)',
      lg: 'var(--shadow-lg)',
    },
    zIndex: {
      10: '10',
      header: 'var(--z-header)',
      sidebar: 'var(--z-sidebar)',
      drawer: 'var(--z-drawer)',
      dock: 'var(--z-dock)',
      overlay: 'var(--z-overlay)',
      modal: 'var(--z-modal)',
      toast: 'var(--z-toast)',
      tooltip: 'var(--z-tooltip)',
      titlebar: 'var(--z-titlebar)',
    },
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      inherit: 'inherit',
      bg: 'var(--bg)',
      surface: {
        1: 'var(--surface-1)',
        2: 'var(--surface-2)',
        3: 'var(--surface-3)',
        hover: 'var(--surface-hover)',
        active: 'var(--surface-active)',
        overlay: 'var(--surface-overlay)',
        media: 'var(--surface-media)',
        'media-hover': 'var(--surface-media-hover)',
      },
      line: {
        subtle: 'var(--border-subtle)',
        DEFAULT: 'var(--border-default)',
        strong: 'var(--border-strong)',
      },
      fg: {
        DEFAULT: 'var(--text-primary)',
        secondary: 'var(--text-secondary)',
        muted: 'var(--text-muted)',
        disabled: 'var(--text-disabled)',
        media: 'var(--text-on-media)',
      },
      accent: {
        DEFAULT: withAlpha('accent'),
        contrast: 'var(--accent-contrast)',
        text: 'var(--accent-text)',
        soft: 'var(--accent-soft)',
        ring: 'var(--accent-ring)',
      },
      success: withAlpha('success'),
      warning: withAlpha('warning'),
      info: withAlpha('info'),
      danger: {
        DEFAULT: withAlpha('danger'),
        strong: 'var(--danger-strong)',
        'strong-hover': 'var(--danger-strong-hover)',
        contrast: 'var(--danger-strong-contrast)',
      },
    },
    extend: {
      spacing: {
        'control-sm': 'var(--control-h-sm)',
        'control-md': 'var(--control-h-md)',
        'control-lg': 'var(--control-h-lg)',
        titlebar: 'var(--titlebar-h)',
        sidebar: 'var(--sidebar-w)',
        'sidebar-collapsed': 'var(--sidebar-w-collapsed)',
        inspector: 'var(--inspector-w)',
        'window-control': '46px',
      },
      maxHeight: {
        chat: '44rem',
        'inspector-chat': '55%',
      },
      gridTemplateColumns: {
        cards: 'repeat(auto-fill, minmax(240px, 1fr))',
      },
      letterSpacing: {
        overline: 'var(--tracking-overline)',
      },
      transitionDuration: {
        fast: 'var(--dur-fast)',
        base: 'var(--dur-base)',
        slow: 'var(--dur-slow)',
      },
      transitionTimingFunction: {
        out: 'var(--ease-out)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'dialog-in': {
          from: { opacity: '0', transform: 'translateY(8px) scale(0.98)' },
          to: { opacity: '1', transform: 'none' },
        },
        'drawer-in': {
          from: { opacity: '0', transform: 'translateX(24px)' },
          to: { opacity: '1', transform: 'none' },
        },
        'rise-in': {
          from: { opacity: '0', transform: 'translateY(12px)' },
          to: { opacity: '1', transform: 'none' },
        },
      },
      animation: {
        'fade-in': 'fade-in var(--dur-base) var(--ease-out) both',
        'dialog-in': 'dialog-in var(--dur-slow) var(--ease-out) both',
        'drawer-in': 'drawer-in var(--dur-slow) var(--ease-out) both',
        'rise-in': 'rise-in var(--dur-slow) var(--ease-out) both',
      },
    },
  },
  plugins: [],
};
