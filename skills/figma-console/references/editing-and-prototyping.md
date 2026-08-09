# Editing and prototyping

## Execute and text

`figma_execute` runs JavaScript in the Desktop Bridge context. Use one quoted
JSON argument (`--args '<json>'`) and keep the script focused. The installed
schema currently defaults to a 5000 ms timeout and caps it at 30000 ms.

Before setting `characters`, `fontName`, or another text style, call and await
`figma.loadFontAsync` for each font/style that will be applied. Then write,
read the node back, and capture a screenshot. If a screenshot still shows old
text while the read-back is new, this is a **session-observed cloned-TEXT stale
render**. `reload_plugin` was observed not to fix it. Delete the clone, await
`loadFontAsync`, create a fresh `figma.createText()`, set `characters` and style
again, then read back and capture a screenshot. It is not an official Figma
guarantee.

## Reactions and Smart Animate

Prototype reactions use the current plugin API shape with an `actions` array;
inspect an existing reaction and preserve its trigger/action fields rather than
inventing a legacy singular `action` field. Smart Animate depends on matching
layer names and compatible hierarchy across destination frames. Verify both
frames' names and nesting before setting the transition.

Cross-page prototype links are **session-observed and require on-site
verification** on the installed Desktop Bridge. If the cross-page link does not
reproduce, use a same-page Bridge helper frame/node while investigating. Do not
describe the workaround as a universal REST or plugin guarantee.

Figma free-plan files are currently observed to cap at three pages (confirm the
active plan before planning page four); this is a session/current-plan fact to
verify, not a substitute for checking the installed account.

## Safe mutation loop

1. Locate the exact page and node and save its current properties.
2. Load fonts, then make the smallest mutation possible.
3. Read the changed node and its relevant parent/flow back.
4. Capture a screenshot with `figma_capture_screenshot` and use
   `--save-images <directory>` when the call supports it.
5. If the result differs, stop and diagnose rather than layering another write.
