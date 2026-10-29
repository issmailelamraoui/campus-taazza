import React from 'react';

export default function BrandMark({className=''}) {
 return <span className={`brand-mark${className?' '+className:''}`} aria-hidden="true"><img src="/icons/campuslink-mark.svg" alt="" width="48" height="48" draggable="false" /></span>;
}
