# Vendored Dependencies

These libraries are vendored (checked into the repo) so the app works with no build step, no package manager, and no CDN dependency.

| Library | Version | Source |
|---------|---------|--------|
| Tone.js | 14.7.77 | https://github.com/Tonejs/Tone.js/releases/tag/v14.7.77 |
| Cytoscape.js | 3.26.0 | https://github.com/cytoscape/cytoscape.js/releases/tag/v3.26.0 |
| lz-string | 1.5.0 | https://github.com/pieroxy/lz-string/releases/tag/1.5.0 |

## Updating a library

1. Download the new release build (minified UMD/IIFE bundle)
2. Replace the file in `vendor/`
3. Update the version comment at the top of the file
4. Update this table
5. Test: open `index.html`, verify audio playback, graph rendering, and URL hash save/restore
