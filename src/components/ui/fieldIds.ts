/** Element ids that tie a field's hint and error text to its control. */
import type React from 'react';

export const hintId = (id: string) => `${id}-hint`;
export const errorId = (id: string) => `${id}-error`;

/** Wires label / hint / error ids for a control (aria-invalid + aria-describedby). */
export const describedBy = (
  id: string,
  hint: React.ReactNode,
  error: string | undefined,
  extra?: string,
) => [extra, error ? errorId(id) : hint ? hintId(id) : null].filter(Boolean).join(' ') || undefined;
