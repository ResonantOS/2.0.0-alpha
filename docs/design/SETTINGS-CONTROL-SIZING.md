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

The live Settings shape check also measures the rendered Appearance select and
save action, Provider modal input, textarea and actions, and Overview setup
action at 390/768/1280px in every density. It waits for the stored Appearance
preference to finish applying, checks 40px in Comfortable and 42px in Touch, and
confirms Compact keeps the smaller Overview action and 9px Settings workspace
gap. Human review still covers the other Settings sections and visual fit,
including wrapping, clipping, and action states; the automated dimensions do not
certify those details.
