import { useState, useEffect, useRef, useCallback } from 'react';
import { profileColumn, profileDateColumn, isDateColumnType } from '../services/duckdb';
import type { ColumnProfile, DateProfile } from '../services/duckdb';

type Granularity = 'hour' | 'day' | 'week' | 'month' | 'year';
const GRAN_LABELS: { key: Granularity; label: string }[] = [
  { key: 'hour', label: 'H' },
  { key: 'day', label: 'D' },
  { key: 'week', label: 'W' },
  { key: 'month', label: 'M' },
  { key: 'year', label: 'Y' },
];

interface ColumnProfilePopoverProps {
  tableName: string;
  columnName: string;
  columnType: string;
  anchorRect: DOMRect;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

// Simple cache for profile data
const profileCache = new Map<string, ColumnProfile>();
const dateProfileCache = new Map<string, DateProfile>();

function cacheKey(table: string, column: string): string {
  return `${table}::${column}`;
}

function dateCacheKey(table: string, column: string, gran: Granularity): string {
  return `${table}::${column}::${gran}`;
}

function autoGranularity(minDate: string, maxDate: string): Granularity {
  try {
    const min = new Date(minDate);
    const max = new Date(maxDate);
    const diffMs = max.getTime() - min.getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    if (diffDays < 2) return 'hour';
    if (diffDays < 60) return 'day';
    if (diffDays < 365) return 'week';
    if (diffDays < 365 * 5) return 'month';
    return 'year';
  } catch {
    return 'month';
  }
}

function formatPeriod(period: string, granularity: Granularity): string {
  try {
    const d = new Date(period);
    if (isNaN(d.getTime())) return period;
    switch (granularity) {
      case 'hour':
        return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' });
      case 'day':
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      case 'week':
        return `Week of ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
      case 'month':
        return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
      case 'year':
        return d.getFullYear().toString();
    }
  } catch {
    return period;
  }
}

export function ColumnProfilePopover({
  tableName,
  columnName,
  columnType,
  anchorRect,
  onMouseEnter,
  onMouseLeave,
}: ColumnProfilePopoverProps) {
  const [profile, setProfile] = useState<ColumnProfile | null>(null);
  const [dateProfile, setDateProfile] = useState<DateProfile | null>(null);
  const [granularity, setGranularity] = useState<Granularity>('month');
  const [loading, setLoading] = useState(true);
  const [dateLoading, setDateLoading] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const isDate = isDateColumnType(columnType);

  // Load column profile
  useEffect(() => {
    const key = cacheKey(tableName, columnName);
    const cached = profileCache.get(key);
    if (cached) {
      setProfile(cached);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    profileColumn(tableName, columnName, columnType).then(data => {
      if (cancelled) return;
      profileCache.set(key, data);
      setProfile(data);
      setLoading(false);
    }).catch(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [tableName, columnName, columnType]);

  // Load date profile
  const loadDateProfile = useCallback((gran: Granularity) => {
    const key = dateCacheKey(tableName, columnName, gran);
    const cached = dateProfileCache.get(key);
    if (cached) {
      setDateProfile(cached);
      setDateLoading(false);
      return;
    }

    setDateLoading(true);
    profileDateColumn(tableName, columnName, gran).then(data => {
      dateProfileCache.set(key, data);
      setDateProfile(data);
      setDateLoading(false);

      // On first load, auto-select granularity based on date range
      if (gran === 'month' && data.minDate && data.maxDate) {
        const autoGran = autoGranularity(data.minDate, data.maxDate);
        if (autoGran !== gran) {
          setGranularity(autoGran);
        }
      }
    }).catch(() => {
      setDateLoading(false);
    });
  }, [tableName, columnName]);

  useEffect(() => {
    if (isDate && !loading) {
      loadDateProfile(granularity);
    }
  }, [isDate, loading, granularity, loadDateProfile]);

  // Position popover
  const [pos, setPos] = useState({ top: 0, left: 0 });
  useEffect(() => {
    const top = anchorRect.bottom + 4;
    let left = anchorRect.left;
    // Ensure it doesn't overflow right edge
    if (popoverRef.current) {
      const popWidth = popoverRef.current.offsetWidth || 300;
      if (left + popWidth > window.innerWidth - 8) {
        left = window.innerWidth - popWidth - 8;
      }
    }
    // Ensure it doesn't overflow bottom
    let adjustedTop = top;
    if (popoverRef.current) {
      const popHeight = popoverRef.current.offsetHeight || 300;
      if (top + popHeight > window.innerHeight - 8) {
        adjustedTop = anchorRect.top - popHeight - 4;
      }
    }
    setPos({ top: adjustedTop, left: Math.max(4, left) });
  }, [anchorRect, profile, dateProfile]);

  const maxCount = profile ? Math.max(...profile.topValues.map(v => v.count), 1) : 1;

  return (
    <div
      ref={popoverRef}
      className="col-profile-popover"
      style={{ top: pos.top, left: pos.left }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* Header */}
      <div className="col-profile-header">
        <span className="col-profile-name">{columnName}</span>
        <span className="col-profile-type">{columnType}</span>
      </div>

      {loading ? (
        <div className="col-profile-loading">
          <div className="col-profile-skeleton" style={{ width: '100%' }} />
          <div className="col-profile-skeleton" style={{ width: '80%' }} />
          <div className="col-profile-skeleton" style={{ width: '60%' }} />
          <div className="col-profile-skeleton" style={{ width: '90%' }} />
        </div>
      ) : profile ? (
        <>
          {/* Null bar */}
          <div className="col-profile-null-bar-container">
            <div className="col-profile-null-bar">
              <div
                className="col-profile-null-bar-filled"
                style={{ width: `${profile.totalRows > 0 ? ((profile.totalRows - profile.nullCount) / profile.totalRows) * 100 : 0}%` }}
              />
              <div className="col-profile-null-bar-empty" style={{ flex: 1 }} />
            </div>
            <div className="col-profile-null-label">
              {profile.nullCount > 0
                ? `${((profile.nullCount / profile.totalRows) * 100).toFixed(1)}% null (${profile.nullCount.toLocaleString()} / ${profile.totalRows.toLocaleString()})`
                : `No nulls (${profile.totalRows.toLocaleString()} rows)`
              }
            </div>
          </div>

          {/* Stats row */}
          <div className="col-profile-stats-row">
            <span>{profile.distinctCount.toLocaleString()} distinct</span>
          </div>

          {/* Top values */}
          <ul className="col-profile-values">
            {profile.topValues.map((item, i) => {
              const pct = (item.count / maxCount) * 100;
              const rowPct = profile.totalRows > 0
                ? ((item.count / profile.totalRows) * 100).toFixed(1)
                : '0';
              return (
                <li key={i} className="col-profile-row">
                  <div className="col-profile-bar" style={{ width: `${pct}%` }} />
                  <span className={`col-profile-value${item.value === 'NULL' ? ' col-profile-value-null' : ''}`}>
                    {item.value}
                  </span>
                  <span className="col-profile-count">
                    {item.count.toLocaleString()} ({rowPct}%)
                  </span>
                </li>
              );
            })}
          </ul>

          {/* Numeric stats */}
          {profile.numericStats && (
            <div className="col-profile-numeric">
              <span className="col-profile-stat-label">min</span>
              <span className="col-profile-stat-value">{profile.numericStats.min}</span>
              <span className="col-profile-stat-label">max</span>
              <span className="col-profile-stat-value">{profile.numericStats.max}</span>
              <span className="col-profile-stat-label">avg</span>
              <span className="col-profile-stat-value">{profile.numericStats.avg}</span>
              <span className="col-profile-stat-label">median</span>
              <span className="col-profile-stat-value">{profile.numericStats.median}</span>
            </div>
          )}

          {/* Date aggregation */}
          {isDate && (
            <div className="col-profile-date-section">
              <div className="col-profile-date-header">
                <div className="col-profile-granularity">
                  {GRAN_LABELS.map(g => (
                    <button
                      key={g.key}
                      className={`col-profile-gran-btn${granularity === g.key ? ' col-profile-gran-active' : ''}`}
                      onClick={() => setGranularity(g.key)}
                    >
                      {g.label}
                    </button>
                  ))}
                </div>
                {dateProfile && (
                  <span className="col-profile-date-range">
                    {formatPeriod(dateProfile.minDate, 'day')} – {formatPeriod(dateProfile.maxDate, 'day')}
                  </span>
                )}
              </div>

              {dateLoading ? (
                <div className="col-profile-loading">
                  <div className="col-profile-skeleton" style={{ width: '100%' }} />
                  <div className="col-profile-skeleton" style={{ width: '70%' }} />
                </div>
              ) : dateProfile && dateProfile.buckets.length > 0 ? (
                <ul className="col-profile-values">
                  {dateProfile.buckets.map((bucket, i) => {
                    const dateMax = Math.max(...dateProfile.buckets.map(b => b.count), 1);
                    const pct = (bucket.count / dateMax) * 100;
                    return (
                      <li key={i} className="col-profile-row">
                        <div className="col-profile-bar" style={{ width: `${pct}%` }} />
                        <span className="col-profile-value">
                          {formatPeriod(bucket.period, granularity)}
                        </span>
                        <span className="col-profile-count">
                          {bucket.count.toLocaleString()}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

// Export for cache invalidation on table edits
export function clearProfileCache(tableName?: string) {
  if (tableName) {
    for (const key of profileCache.keys()) {
      if (key.startsWith(`${tableName}::`)) profileCache.delete(key);
    }
    for (const key of dateProfileCache.keys()) {
      if (key.startsWith(`${tableName}::`)) dateProfileCache.delete(key);
    }
  } else {
    profileCache.clear();
    dateProfileCache.clear();
  }
}
