// Keep worker, mapping tables, standard fonts and decoders from the same pinned
// PDF.js installation. No CDN request or private document data is involved.
export const pdfAssetOptions=version=>{
 if(!/^\d+\.\d+\.\d+$/.test(version))throw new Error('Version PDF.js invalide.');
 const base=`/pdfjs-assets/${version}/`;
 return {cMapUrl:base+'cmaps/',cMapPacked:true,standardFontDataUrl:base+'standard_fonts/',wasmUrl:base+'wasm/',iccUrl:base+'iccs/'};
};
