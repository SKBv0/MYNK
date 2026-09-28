import React from 'react';

/** Blinking caret shown at the end of a streaming answer (decorative). */
const StreamingCursor: React.FC = () => (
  <span
    aria-hidden
    className="ml-0.5 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-accent align-text-bottom motion-reduce:animate-none"
  />
);

export default StreamingCursor;
