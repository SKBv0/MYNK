import React from 'react';
import { Loader2 } from 'lucide-react';
import { cx } from './cx';

interface SpinnerProps {
  size?: number;
  className?: string;
}

/** Decorative loading indicator. */
export const Spinner: React.FC<SpinnerProps> = ({ size = 16, className }) => (
  <Loader2 size={size} className={cx('animate-spin', className)} aria-hidden />
);
