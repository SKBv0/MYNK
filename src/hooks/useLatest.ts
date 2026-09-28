import { useEffect, useRef, type MutableRefObject } from 'react';

/**
 * A ref holding the newest render's value, so an effect can read it without listing it as a
 * dependency (a mount effect stays a mount effect).
 */
export const useLatest = <T>(value: T): MutableRefObject<T> => {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
};
