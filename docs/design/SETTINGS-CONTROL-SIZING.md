# Settings control sizing

The browser-first Settings workspace and provider modal follow the
[ROSI v3 control-height guidance](rosi-design-system/reference/ui-extraction-browser-v3.md):
standard text actions, single-line fields and selects have a 40px minimum height.
The default density and explicit `comfortable` density use this rule.

Compact density retains its existing compact padding. Touch density retains
the existing global 42px minimum. These are minimums, not fixed heights: large
text and wrapped labels may grow. Navigation rows, icon-only buttons, native
checkboxes/radios, range controls and hidden inputs are excluded from the new
standard-density rule. Textareas retain their multiline sizing.

This contract changes height only. Palette, corner shapes, field behavior and
preference persistence are separate concerns. Check Overview actions,
Appearance selects and provider form fields at narrow/wide widths and all
three densities before changing the rule.
