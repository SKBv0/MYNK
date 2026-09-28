//! Epoch milliseconds in and out of the ISO-8601 / relative-window forms an agent uses.
//!
//! No date crate in this workspace; the calendar math is the standard `days_from_civil` pair.

pub use crate::util::now_ms;

const DAY_MS: i64 = 86_400_000;

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// Inverse of [`days_from_civil`]: `(year, month, day)`.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let mp = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    (year + i64::from(month <= 2), month, day)
}

/// `2026-09-13T12:34:56Z`, sub-second precision dropped.
pub fn to_iso(ms: i64) -> String {
    let days = ms.div_euclid(DAY_MS);
    let rest = ms.rem_euclid(DAY_MS) / 1000;
    let (year, month, day) = civil_from_days(days);
    let (hour, minute, second) = (rest / 3600, (rest % 3600) / 60, rest % 60);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// [`to_iso`], with `0` and `None` both meaning "not set".
pub fn to_iso_opt(ms: Option<i64>) -> Option<String> {
    ms.filter(|value| *value > 0).map(to_iso)
}

fn digits(value: &str) -> Option<i64> {
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

/// Parses a relative window (`30m`, `24h`, `7d`, `2w`) into milliseconds.
pub fn parse_relative(value: &str) -> Option<i64> {
    let mut chars = value.trim().chars();
    // `split_at` is a byte index; take the last char instead so multi-byte input can't panic.
    let unit = chars.next_back()?;
    let count = digits(chars.as_str())?;
    let unit_ms = match unit {
        'm' => 60_000,
        'h' => 3_600_000,
        'd' => DAY_MS,
        'w' => 7 * DAY_MS,
        _ => return None,
    };
    count.checked_mul(unit_ms)
}

/// Parses `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM[:SS][Z]` as UTC.
fn parse_iso(value: &str) -> Option<i64> {
    let trimmed = value.trim().trim_end_matches('Z');
    let (date, time) = match trimmed.split_once(['T', ' ']) {
        Some((date, time)) => (date, time),
        None => (trimmed, ""),
    };
    let mut date_parts = date.split('-');
    let year = digits(date_parts.next()?)?;
    let month = digits(date_parts.next()?)?;
    let day = digits(date_parts.next()?)?;
    if date_parts.next().is_some()
        || !(1..=9999).contains(&year)
        || !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
    {
        return None;
    }
    let mut hour = 0;
    let mut minute = 0;
    let mut second = 0;
    if !time.is_empty() {
        let mut time_parts = time.split(':');
        hour = digits(time_parts.next()?)?;
        minute = digits(time_parts.next().unwrap_or("0"))?;
        let seconds = time_parts.next().unwrap_or("0");
        second = digits(seconds.split('.').next().unwrap_or("0"))?;
        if time_parts.next().is_some() || hour > 23 || minute > 59 || second > 60 {
            return None;
        }
    }
    let days = days_from_civil(year, month, day);
    days.checked_mul(DAY_MS)?
        .checked_add((hour * 3600 + minute * 60 + second) * 1000)
}

/// An ISO-8601 instant, or a relative window (`7d`) meaning that long before `now`.
pub fn parse_instant(value: &str, now: i64) -> Result<i64, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("The time value is empty.".to_string());
    }
    if let Some(window) = parse_relative(trimmed) {
        return Ok(now - window);
    }
    parse_iso(trimmed).ok_or_else(|| {
        format!("\"{trimmed}\" is not an ISO-8601 time or a relative window like \"7d\".")
    })
}

/// `days` before `now`, floored at the epoch.
pub fn days_before(now: i64, days: u32) -> i64 {
    now.saturating_sub(i64::from(days).saturating_mul(DAY_MS))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_epoch_milliseconds_as_utc() {
        assert_eq!(to_iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(to_iso(1_757_700_000_000), "2025-09-12T18:00:00Z");
        assert_eq!(to_iso(1_709_208_000_000), "2024-02-29T12:00:00Z");
        assert_eq!(to_iso(1_735_689_599_000), "2024-12-31T23:59:59Z");
        assert_eq!(to_iso_opt(None), None);
        assert_eq!(to_iso_opt(Some(0)), None, "0 is not a timestamp");
        assert_eq!(
            to_iso_opt(Some(1_000)).as_deref(),
            Some("1970-01-01T00:00:01Z")
        );
    }

    #[test]
    fn round_trips_every_day_of_a_leap_year() {
        for day in 0..366 {
            let ms = days_from_civil(2024, 1, 1) * DAY_MS + day * DAY_MS;
            let parsed = parse_iso(&to_iso(ms)).expect("round trip");
            assert_eq!(parsed, ms, "day {day}");
        }
    }

    #[test]
    fn parses_relative_windows() {
        assert_eq!(parse_relative("30m"), Some(1_800_000));
        assert_eq!(parse_relative("24h"), Some(86_400_000));
        assert_eq!(parse_relative(" 7d "), Some(7 * DAY_MS));
        assert_eq!(parse_relative("2w"), Some(14 * DAY_MS));
        assert_eq!(parse_relative("7"), None);
        assert_eq!(parse_relative("d"), None);
        assert_eq!(parse_relative("-1d"), None);
        assert_eq!(parse_relative("7y"), None);
        assert_eq!(parse_relative(""), None);
    }

    #[test]
    fn parses_instants_in_both_spellings() {
        let now = 1_757_700_000_000;
        assert_eq!(
            parse_instant("7d", now).expect("relative"),
            now - 7 * DAY_MS
        );
        assert_eq!(
            parse_instant("2026-09-13", now).expect("date"),
            days_from_civil(2026, 9, 13) * DAY_MS
        );
        assert_eq!(
            parse_instant("2026-09-13T06:30:00Z", now).expect("datetime"),
            days_from_civil(2026, 9, 13) * DAY_MS + 23_400_000
        );
        assert_eq!(
            parse_instant("2026-09-13T06:30:00.500Z", now).expect("fractional"),
            days_from_civil(2026, 9, 13) * DAY_MS + 23_400_000
        );
        for bad in [
            "",
            "  ",
            "yesterday",
            "2026-13-01",
            "2026-09-32",
            "2026/09/13",
        ] {
            let error = parse_instant(bad, now).expect_err(bad);
            assert!(!error.is_empty(), "{bad}");
        }
    }

    #[test]
    fn rejects_years_outside_the_four_digit_range() {
        let now = 1_757_700_000_000;
        for bad in [
            "99999999999-01-01",
            "9223372036854775807-12-31",
            "10000-01-01",
            "0000-01-01",
        ] {
            assert!(parse_iso(bad).is_none(), "{bad}");
            parse_instant(bad, now).expect_err(bad);
        }
        assert_eq!(
            parse_iso("0001-01-01"),
            Some(days_from_civil(1, 1, 1) * DAY_MS)
        );
        assert_eq!(
            parse_iso("9999-12-31T23:59:59Z"),
            Some(days_from_civil(9999, 12, 31) * DAY_MS + 86_399_000)
        );
    }

    #[test]
    fn days_before_does_not_wrap() {
        let now = 1_757_700_000_000;
        assert_eq!(days_before(now, 0), now);
        assert_eq!(days_before(now, 7), now - 7 * DAY_MS);
        assert!(days_before(now, u32::MAX) < now);
    }
}
