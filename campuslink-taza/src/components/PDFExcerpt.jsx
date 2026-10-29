import React from 'react';
import {useApp} from '../context';
import {assessPDFText} from '../../shared/pdf-text.js';
import './pdf-excerpt.css';

// Existing saved text is never rewritten. Its original page/image remains the
// authority when a PDF font cannot supply trustworthy Unicode characters.
export default function PDFExcerpt({item={},text=item.selectedText||'',imageData=item.imageData||'',children}) {
 const{tr}=useApp(),quality=assessPDFText(text);
 if(!text&&!imageData)return children||null;
 return <div className="pdf-saved-excerpt">
  {imageData&&<figure><img src={imageData} alt={tr('Extrait original du document','Original document excerpt','المقتطف الأصلي من المستند')}/><figcaption>{tr('Extrait original','Original excerpt','المقتطف الأصلي')}</figcaption></figure>}
  {!quality.reliable&&<p className="pdf-excerpt-warning" role="status">{tr('Le texte enregistré contient des caractères non fiables. Vérifiez l’extrait original ou sa page source ; votre texte est conservé.','The saved text contains unreliable characters. Check the original excerpt or source page; your text is preserved.','النص المحفوظ فيه رموز غير موثوقة. راجع المقتطف الأصلي أو صفحة المصدر؛ النص ديالك باقي محفوظ.')}</p>}
  {text&&(imageData||!quality.reliable?<details><summary>{quality.reliable?tr('Texte extrait','Extracted text','النص المستخرج'):tr('Afficher le texte enregistré','Show saved text','عرض النص المحفوظ')}</summary><blockquote className="pdf-math-text" dir="auto">{text}</blockquote></details>:<blockquote className="pdf-math-text" dir="auto">{text}</blockquote>)}
  {children}
 </div>;
}
