import React from 'react';
import { useApp } from '../context';
import './page-loading.css';
import {
  DocumentGridSkeleton,
  CampusGridSkeleton,
  TableSkeleton,
  ReaderSkeleton,
  PageSkeleton,
} from './Shimmer';

export default function PageLoading({ fullPage = false, label, kind = "page" }) {
  const { tr } = useApp();
  const defaultLabel = label || tr('Chargement de la page…', 'Loading page…', 'جارٍ تحميل الصفحة…');

  const renderSkeleton = () => {
    switch (kind) {
      case 'document':
      case 'reader':
        return <ReaderSkeleton label={defaultLabel} />;
      case 'cards':
      case 'grid':
        return <DocumentGridSkeleton count={fullPage ? 6 : 4} />;
      case 'forum':
      case 'campus':
        return <CampusGridSkeleton count={fullPage ? 6 : 3} />;
      case 'table':
        return <TableSkeleton rows={fullPage ? 7 : 4} />;
      case 'simple':
      case 'inline':
        return (
          <div className="loading-placeholders" aria-hidden="true">
            <i /><i /><i />
          </div>
        );
      case 'page':
      default:
        return fullPage ? (
          <PageSkeleton count={6} label={defaultLabel} />
        ) : (
          <div className="page-loading-skeletons">
            <div className="loading-placeholders" aria-hidden="true" style={{ marginBottom: 20 }}>
              <i /><i /><i />
            </div>
            <DocumentGridSkeleton count={3} />
          </div>
        );
    }
  };

  return (
    <div
      className={`page-loading${fullPage ? ' page-loading-full' : ''}`}
      data-kind={kind}
      role="status"
      aria-live="polite"
    >
      <div className="page-loading-header">
        <span className="page-loading-indicator" aria-hidden="true" />
        <span>{defaultLabel}</span>
      </div>
      {renderSkeleton()}
    </div>
  );
}
