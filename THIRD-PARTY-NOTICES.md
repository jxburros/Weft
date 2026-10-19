# Third-party acknowledgements

The anti-overlap guard in `src/standby.js` adapts
`app/backend/src/services/internSchedules.ts` from
[JX Holdings' AI Server Studio](https://github.com/jxburros/AI-Server-Studio).
It has been modified for Weft task states. The original is licensed under the
[Apache License 2.0](licenses/AI-Server-Studio-Apache-2.0.txt).

[GWatch](https://github.com/jxburros/GWatch)'s `internal/engine/automation.go`
was reviewed for its per-trigger cooldown and reserve-before-dispatch design.
Weft independently implements those scheduling ideas; no GWatch source is
copied into this MIT-licensed application.

The bundled Source Sans 3 font (`assets/fonts/`) is © Adobe and licensed under
the SIL Open Font License 1.1; see [assets/fonts/LICENSE.md](assets/fonts/LICENSE.md).
