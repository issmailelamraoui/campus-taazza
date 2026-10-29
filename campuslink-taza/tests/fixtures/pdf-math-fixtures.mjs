import {readFileSync} from 'node:fs';
export const MATH_PDF_LINES=Object.freeze([
 'Mathematical PDF fixture',
 'Greek: α β θ λ μ σ Ω',
 'Sets: ∈ ∉ ⊂ ∪ ∩ ∅ ℝ ℕ ℤ ℚ',
 'Probability: P(A ∩ B) = P(A)P(B)',
 'Operators: ∫ ∑ √x ≤ ≥ ≠ ∞',
]);
export function mathematicalPDFFixture({unreliable=false}={}){
 return readFileSync(new URL(unreliable?'./math-unreliable-map.pdf':'./math-unicode.pdf',import.meta.url));
}
