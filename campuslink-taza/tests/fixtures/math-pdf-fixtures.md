# Mathematical PDF fixtures

`math-unicode.pdf` contains only synthetic academic examples. Its embedded Noto Sans Math subset has valid `/ToUnicode` mappings for Greek letters, set notation and mathematical operators. A fraction and positioned exponent/subscript also exercise visual layout which plain text cannot faithfully flatten.

`math-unreliable-map.pdf` retains the same page drawing commands and embedded font outlines. Exactly three mappings are intentionally corrupted: α becomes U+E100, Ω becomes U+0003 and ℝ becomes U+0087. The page still paints its original glyph shapes; extracting those mappings as ordinary student text is unsafe. This represents missing/broken encoding cases without distributing a real student's document or copyrighted course pages.

The subset font comes from the Noto Project under SIL OFL 1.1; see `NotoSansMath-OFL.txt`. Upstream source: https://github.com/google/fonts/tree/main/ofl/notosansmath

Source TTF SHA-256: `3f495fe933c06786e4d5f6d86b8ee70b6753a68ee3b9d87528726de0f6e2c47d`. Full font files are not runtime dependencies of the application or test suite; the small subsets are embedded in the PDF fixtures.
