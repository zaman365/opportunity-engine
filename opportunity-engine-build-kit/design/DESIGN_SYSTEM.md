# Design-system direction and token contract

## What is binding

Use semantic tokens, predictable spacing, legible hierarchy, contrast-checked statuses, accessible focus and responsive density. Do not hardcode a new color or radius in every component. Tokens are not substitutes for composed screens.

## What is provisional

`tokens.css` and `tokens.json` describe the **Evidence Desk concept**, not an imposed final identity. The designer may change them through the design decision record after testing the same tasks and accessibility. The neutral hierarchy, semantic distinctions and component-state coverage must survive.

## Type roles

Display: optional editorial voice on overview/report titles, never everywhere.
Case heading: clear sans, 22–30 px depending on context.
Section heading: 15–18 px, medium/semibold; don't uppercase every heading.
UI/body: normally 14–16 px on desktop; 16 px form inputs on mobile.
Metadata: normally 12–13 px, sufficient contrast, no essential 10 px gray labels.
Numbers/code/source IDs: system monospace or a licensed compatible mono, sparingly.

Preview system stacks are intentional portability, not a final typography decision. Production font selection requires actual language glyph review, load behavior, license and performance. No font files are distributed in the kit.

## Spatial grammar

Base spacing 4 px with a considered scale: 4, 8, 12, 16, 24, 32, 48, 64. Break the scale deliberately only when optical alignment requires it. List rows compact but usable, approximately 56–72 px by content; touch targets not confused with visible icon dimensions. Evidence stage has generous space; dense metadata uses alignment, not dozens of boxes. Avoid default 24 px padding on every nested wrapper.

## Shape and elevation

Tight small controls, restrained panel radius, almost-square work surfaces. Border/rule defines grouping; shadow indicates a floating layer, not “premium.” Keep hover/focus/selected states different. No full-screen dark/glass theme just because the product uses AI. Dark mode is later only after the light interface is coherent and all evidence/status states work.

## Semantics

Ink, secondary ink, paper, subtle surface, rule, strong rule, focus, approved, attention, danger. Brand accent is separate from status. A green approved label does not turn the entire card green. Permission-denied and detector-failed are not the same state. Unknown uses text/icon semantics, not a success tint.

## Motion

Short movement for spatial continuity; opacity changes for temporary overlays; no ornamental springing of evidence. Respect `prefers-reduced-motion`. Pending server state has an accessible live status, not a simulated progress percentage. Preserve layout while data arrives.

## Components derive from screens

After selecting a composition, extract CaseRow, EvidenceStage, SourceStrip, FindingNarrative, ReviewSeam, CoverageSummary, BudgetSummary and ReportSection. Avoid adopting an entire generic component gallery before proving the review journey.
