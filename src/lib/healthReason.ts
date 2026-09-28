import type { ResourceHealth } from '../types';
import type { TranslationSchema } from '../translations/en';

type KnownStatus = keyof TranslationSchema['health']['httpStatuses'];

const isKnownStatus = (status: number, t: TranslationSchema): status is KnownStatus =>
  Object.prototype.hasOwnProperty.call(t.health.httpStatuses, status);

/** Short reason a check gave for a broken link ("404 Not Found", "Address not found"), or `null`. */
export const healthReason = (health: ResourceHealth, t: TranslationSchema): string | null => {
  const status = health.httpStatus;
  if (status !== undefined && status >= 400) {
    return isKnownStatus(status, t) ? `${status} ${t.health.httpStatuses[status]}` : String(status);
  }
  return health.errorKind ? t.health.reasons[health.errorKind] : null;
};
