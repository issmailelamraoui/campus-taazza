import React from 'react';
import './shimmer.css';

/**
 * Base Shimmer primitive block
 */
export function Shimmer({
  width,
  height,
  radius,
  className = '',
  style = {},
  variant = 'block', // 'block' | 'line' | 'circle' | 'badge' | 'btn' | 'chip'
  ...props
}) {
  const inlineStyle = {
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(radius !== undefined ? { borderRadius: radius } : {}),
    ...style,
  };

  return (
    <div
      className={`shimmer-${variant} ${className}`}
      style={inlineStyle}
      aria-hidden="true"
      {...props}
    />
  );
}

/**
 * Multi-line Shimmer Text
 */
export function ShimmerText({
  lines = 3,
  lineHeight = 14,
  gap = 10,
  lastLineWidth = '65%',
  className = '',
  style = {},
}) {
  return (
    <div
      className={`shimmer-text-group ${className}`}
      style={{ display: 'flex', flexDirection: 'column', gap, ...style }}
      aria-hidden="true"
    >
      {Array.from({ length: lines }).map((_, i) => (
        <Shimmer
          key={i}
          variant="line"
          height={lineHeight}
          width={i === lines - 1 && lastLineWidth ? lastLineWidth : '100%'}
        />
      ))}
    </div>
  );
}

/**
 * Document Card Skeleton matching DocumentCard.jsx layout
 */
export function DocumentCardSkeleton({ compact = false }) {
  return (
    <article className="shimmer-document-card" role="status" aria-label="Loading document…">
      <div className="shimmer-doc-header">
        <Shimmer variant="block" className="shimmer-doc-icon" />
        <div className="shimmer-doc-title-lines">
          <Shimmer variant="line" height={16} width="85%" />
          <Shimmer variant="line" height={13} width="60%" />
        </div>
      </div>
      <div className="shimmer-doc-badges">
        <Shimmer variant="badge" width={75} />
        <Shimmer variant="badge" width={55} />
        <Shimmer variant="badge" width={40} />
      </div>
      <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Shimmer variant="line" height={11} width="45%" />
      </div>
      <div className="shimmer-doc-footer">
        <Shimmer variant="btn" width={110} height={26} />
        <div style={{ display: 'flex', gap: '6px' }}>
          <Shimmer variant="circle" width={28} height={28} />
          <Shimmer variant="circle" width={28} height={28} />
        </div>
      </div>
    </article>
  );
}

/**
 * Document Grid Skeleton
 */
export function DocumentGridSkeleton({ count = 6 }) {
  return (
    <div className="shimmer-grid">
      {Array.from({ length: count }).map((_, i) => (
        <DocumentCardSkeleton key={i} />
      ))}
    </div>
  );
}

/**
 * Announcement Card Skeleton
 */
export function AnnouncementCardSkeleton({ compact = false }) {
  return (
    <article className="shimmer-announcement-card" role="status" aria-label="Loading announcement…">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Shimmer variant="badge" width={90} height={18} />
        <Shimmer variant="badge" width={60} height={18} />
      </div>
      <div style={{ margin: '4px 0' }}>
        <Shimmer variant="line" height={18} width="80%" style={{ marginBottom: 10 }} />
        <Shimmer variant="line" height={13} width="100%" style={{ marginBottom: 6 }} />
        <Shimmer variant="line" height={13} width="70%" />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
        <Shimmer variant="line" height={12} width={130} />
        <Shimmer variant="circle" width={24} height={24} />
      </div>
    </article>
  );
}

/**
 * Campus Card Skeleton (for questions, study groups, market items)
 */
export function CampusCardSkeleton() {
  return (
    <article className="shimmer-campus-card" role="status" aria-label="Loading…">
      <Shimmer variant="line" height={18} width="75%" style={{ marginBottom: 6 }} />
      <Shimmer variant="line" height={13} width="95%" style={{ marginBottom: 4 }} />
      <Shimmer variant="line" height={13} width="65%" style={{ marginBottom: 12 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 'auto' }}>
        <Shimmer variant="circle" width={24} height={24} />
        <Shimmer variant="line" height={12} width={120} />
        <Shimmer variant="badge" width={65} height={18} style={{ marginInlineStart: 'auto' }} />
      </div>
    </article>
  );
}

export function CampusGridSkeleton({ count = 4 }) {
  return (
    <div className="campus-cards" style={{ width: '100%' }}>
      {Array.from({ length: count }).map((_, i) => (
        <CampusCardSkeleton key={i} />
      ))}
    </div>
  );
}

/**
 * Table Skeleton (for Admin, Permissions, Spreadsheets)
 */
export function TableSkeleton({ rows = 5, cols = 4 }) {
  const columnWidths = Array.from({ length: cols }, (_, index) => index === 0 ? 30 : Math.floor(70 / Math.max(1, cols - 1)));
  return (
    <div className="shimmer-table-card" role="status" aria-label="Loading table…">
      <div className="shimmer-table-header">
        {columnWidths.map((width, index) => <Shimmer key={index} variant="line" height={15} width={`${width}%`} />)}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div className="shimmer-table-row" key={r}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: `${columnWidths[0]}%` }}>
            <Shimmer variant="circle" width={30} height={30} />
            <div style={{ flex: 1 }}>
              <Shimmer variant="line" height={14} width="85%" style={{ marginBottom: 5 }} />
              <Shimmer variant="line" height={11} width="50%" />
            </div>
          </div>
          {columnWidths.slice(1).map((width, index) => <div key={index} style={{ width: `${width}%` }}>
            {index === columnWidths.length - 2 ? <Shimmer variant="btn" width={70} height={26} /> : <Shimmer variant={index === 0 ? 'badge' : 'line'} height={index === 0 ? 20 : 13} width={index === 0 ? 80 : '70%'} />}
          </div>)}
        </div>
      ))}
    </div>
  );
}

/**
 * Reader Skeleton (for PDF and text documents)
 */
export function ReaderSkeleton({ label }) {
  return (
    <div className="shimmer-reader-container" role="status" aria-label={label || 'Loading document…'}>
      <div className="shimmer-reader-toolbar">
        <Shimmer variant="btn" width={70} height={28} />
        <Shimmer variant="btn" width={90} height={28} />
        <Shimmer variant="btn" width={60} height={28} />
        <div style={{ marginInlineStart: 'auto', display: 'flex', gap: 8 }}>
          <Shimmer variant="circle" width={28} height={28} />
          <Shimmer variant="circle" width={28} height={28} />
        </div>
      </div>
      <div className="shimmer-reader-canvas">
        <div className="shimmer-reader-page">
          <Shimmer variant="line" height={26} width="45%" style={{ margin: '0 auto 30px' }} />
          <Shimmer variant="line" height={15} width="90%" style={{ marginBottom: 12 }} />
          <Shimmer variant="line" height={15} width="96%" style={{ marginBottom: 12 }} />
          <Shimmer variant="line" height={15} width="88%" style={{ marginBottom: 12 }} />
          <Shimmer variant="line" height={15} width="65%" style={{ marginBottom: 26 }} />

          <Shimmer variant="line" height={20} width="50%" style={{ marginBottom: 16 }} />
          <Shimmer variant="line" height={15} width="92%" style={{ marginBottom: 12 }} />
          <Shimmer variant="line" height={15} width="95%" style={{ marginBottom: 12 }} />
          <Shimmer variant="line" height={15} width="70%" style={{ marginBottom: 28 }} />

          <Shimmer variant="block" height={180} width="100%" radius={8} style={{ marginBottom: 28 }} />

          <Shimmer variant="line" height={15} width="94%" style={{ marginBottom: 12 }} />
          <Shimmer variant="line" height={15} width="78%" />
        </div>
      </div>
    </div>
  );
}

/**
 * Spreadsheet Preview Skeleton
 */
export function SpreadsheetSkeleton() {
  return (
    <div className="shimmer-spreadsheet-wrap" role="status" aria-label="Loading spreadsheet…">
      <div className="shimmer-spreadsheet-toolbar">
        <Shimmer variant="btn" width={110} height={30} />
        <Shimmer variant="btn" width={80} height={30} />
        <Shimmer variant="line" width={160} height={24} style={{ marginInlineStart: 'auto' }} />
      </div>
      <div className="shimmer-spreadsheet-grid">
        <div className="shimmer-spreadsheet-row shimmer-spreadsheet-header">
          <div className="shimmer-spreadsheet-cell-index">#</div>
          {['A', 'B', 'C', 'D', 'E', 'F'].map(col => (
            <div key={col} className="shimmer-spreadsheet-col-header">
              <strong style={{ fontSize: 11, color: 'var(--muted)', margin: 'auto' }}>{col}</strong>
            </div>
          ))}
        </div>
        {Array.from({ length: 9 }).map((_, r) => (
          <div key={r} className="shimmer-spreadsheet-row">
            <div className="shimmer-spreadsheet-cell-index">{r + 1}</div>
            {Array.from({ length: 6 }).map((_, c) => (
              <div key={c} className="shimmer-spreadsheet-cell">
                <Shimmer
                  variant="line"
                  height={13}
                  width={`${35 + ((r * 19 + c * 31) % 55)}%`}
                />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Profile / Form Skeleton
 */
export function ProfileSkeleton() {
  return (
    <div className="shimmer-card" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <Shimmer variant="circle" width={68} height={68} />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Shimmer variant="line" height={20} width="60%" />
          <Shimmer variant="line" height={14} width="40%" />
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Shimmer variant="line" height={14} width="30%" />
        <Shimmer variant="block" height={38} width="100%" radius={7} />
        <Shimmer variant="line" height={14} width="25%" />
        <Shimmer variant="block" height={38} width="100%" radius={7} />
        <Shimmer variant="line" height={14} width="35%" />
        <Shimmer variant="block" height={80} width="100%" radius={7} />
      </div>
      <Shimmer variant="btn" width={140} height={38} style={{ marginTop: 10 }} />
    </div>
  );
}

/**
 * Full Page Skeleton layout
 */
export function PageSkeleton({ count = 6, label }) {
  return (
    <div className="shimmer-page-layout" role="status" aria-label={label || 'Loading page…'}>
      <div className="shimmer-page-header">
        <Shimmer variant="badge" width={120} height={18} />
        <Shimmer variant="line" height={30} width="45%" style={{ margin: '4px 0' }} />
        <Shimmer variant="line" height={15} width="65%" />
      </div>
      <div className="shimmer-toolbar">
        <Shimmer variant="block" height={38} width="min(340px, 100%)" radius={8} />
        <Shimmer variant="chip" width={90} height={34} />
        <Shimmer variant="chip" width={100} height={34} />
        <Shimmer variant="chip" width={80} height={34} />
      </div>
      <div className="shimmer-generic-grid">
        {Array.from({ length: count }).map((_, index) => <article className="shimmer-generic-card" key={index}>
          <div className="shimmer-generic-card-heading"><Shimmer variant="circle" width={34} height={34} /><Shimmer variant="line" width="48%" height={16} /></div>
          <ShimmerText lines={2 + (index % 2)} lineHeight={13} gap={10} lastLineWidth="72%" />
          <div className="shimmer-generic-card-footer"><Shimmer variant="badge" width={74} /><Shimmer variant="btn" width={86} height={30} /></div>
        </article>)}
      </div>
    </div>
  );
}

/**
 * Full-screen Session Status Skeleton (for initial startup loading)
 */
export function SessionStatusSkeleton({ children }) {
  return (
    <div className="shimmer-session-screen" role="status" aria-busy="true">
      <header className="shimmer-session-nav">
        <Shimmer variant="circle" width={32} height={32} />
        <Shimmer variant="line" width={140} height={18} />
        <div style={{ marginInlineStart: 'auto', display: 'flex', gap: 14 }}>
          <Shimmer variant="badge" width={80} height={22} />
          <Shimmer variant="circle" width={28} height={28} />
        </div>
      </header>
      <main className="shimmer-session-main">
        {children && (
          <div style={{ display: 'grid', placeItems: 'center', margin: '20px auto 10px', width: '100%' }}>
            {children}
          </div>
        )}
        <div className="shimmer-page-header">
          <Shimmer variant="badge" width={130} height={20} />
          <Shimmer variant="line" height={32} width="50%" style={{ margin: '6px 0' }} />
          <Shimmer variant="line" height={16} width="70%" />
        </div>
        <div className="shimmer-grid">
          {Array.from({ length: 4 }).map((_, i) => (
            <DocumentCardSkeleton key={i} />
          ))}
        </div>
      </main>
    </div>
  );
}
