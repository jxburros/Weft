# Weft — Visual Style Guide

**Version:** 1.0  
**Date:** October 17, 2026  
**Status:** Proposed aesthetic direction for review

This guide is the design direction. The values implemented against it (tokens, type scale, spacing, motion, layout and components) are recorded in [docs/DESIGN-SYSTEM.md](docs/DESIGN-SYSTEM.md), together with the choices that still need human sign-off. Where this guide says a value is not yet defined, see that document.

## 1. Brand and product

**Name:** Weft  
**Product:** An AI-first browser built around persistent project workspaces, usable by humans and by internal and external agents.

The name suggests weaving separate pieces into something useful: tabs, materials, conversations, tasks, evidence, and agents come together within a project.

The visual direction is **a modern creative studio**: warm surfaces, precise controls, and restrained woven details. Weft should feel like somewhere you can leave a project ready to pick up again.

The name is selected. The colors, typography, layout treatments, and logo directions in this guide remain design proposals. No final logo has been selected or rendered as part of this guide.

## 2. Personality

| Quality | Visual expression |
| --- | --- |
| Warm | Ivory backgrounds, soft whites, muted natural accents |
| Capable | Precise alignment, clear hierarchy, readable controls |
| Creative | Plum identity, visual reference collections, a subtle woven mark |
| Calm | Restrained motion, quiet indicators, minimal visual clutter |
| Dependable | Stable layouts, clear ownership, visible action states |
| Human | Familiar labels, approachable typography, understandable explanations |

Weft should be comfortable for artistic projects, research, and software work. Its identity should accommodate serious browser and agent controls without making the entire product feel like a developer console.

## 3. Use of the weaving metaphor

Let the logo and a few visual details carry the metaphor. Use familiar interface labels such as **Workspaces, Tabs, Materials, Tasks, Conversations, Artifacts, and Activity**.

Do not require users to learn a textile vocabulary to operate the browser. Terms such as looms, threads, and tapestries should not replace ordinary navigation labels merely to reinforce the name.

The workspace naming choice—Workspaces, Desks, or Hubs—remains open. Designs should use **Workspaces** provisionally until that decision is made.

## 4. Color palette

### 4.1 Proposed light palette

| Token | Name | Hex | Intended use |
| --- | --- | --- | --- |
| `canvas` | Warm ivory | `#F4F1EA` | Main application background and workspace surroundings |
| `surface` | Soft white | `#FCFAF6` | Panels, cards, menus, and elevated surfaces |
| `ink` | Charcoal | `#27252B` | Main text and strong controls |
| `brand` | Weft plum | `#70516F` | Primary actions, selected elements, and branding |
| `accent-sage` | Muted sage | `#718676` | Secondary accents and workspace identities |
| `accent-clay` | Warm terracotta | `#B97359` | Occasional emphasis and workspace identities |

Use warm neutrals for most of the interface. Plum should establish identity without overwhelming page content. Plum is the default interface accent; a person can choose an ocean, forest or rose accent instead, which replaces plum on primary actions and selection but does not change the logo, the focus indicator or the browser-owned control band. Sage and clay are supporting accents, not substitutes for a complete semantic status palette.

These are starting colors, not accessibility-certified combinations. Validate text, icons, borders, selected states, and disabled states against their actual backgrounds before implementation. Do not assume every accent supports small text or white lettering.

### 4.2 Dark mode

Use ink-charcoal backgrounds, warm gray surfaces, and a lighter orchid accent. Preserve the same calm studio character and information hierarchy as light mode.

Dark-mode values are implemented in `assets/tokens.json` but await sign-off (see [docs/DESIGN-SYSTEM.md](docs/DESIGN-SYSTEM.md)). Design its surfaces, contrast, separators, focus indicators, and status treatments deliberately rather than mechanically inverting the light palette.

### 4.3 Workspace colors

Each workspace receives a color and a simple symbol. Repeat the accent selectively in:

- Its sidebar identity.
- The active-tab marker.
- Workspace overview details.
- Small contextual labels where useful.

Do not recolor the entire application window for every workspace. Workspace identity should remain legible alongside agent states and security indicators.

## 5. Typography

Use a readable sans serif with slightly human shapes.

| Candidate | Character | Proposed role |
| --- | --- | --- |
| **Source Sans 3** | Clear, approachable, flexible | First visual starting point for application typography |
| **IBM Plex Sans** | More technical and structured | Alternative for a stronger studio/tool character |

No final typeface has been selected.

### 5.1 Hierarchy

- Clear workspace and page titles.
- Readable section headings with restrained weight changes.
- Compact but comfortable browser-control labels.
- More generous spacing for project summaries, notes, and materials.
- Secondary metadata that remains readable rather than becoming faint decoration.

Use monospace sparingly for CLI commands, identifiers, and technical inspection. Ordinary chat, tasks, and browsing controls should remain in the main interface typeface.

Source Sans 3 and a rem-based type scale are implemented (see [docs/DESIGN-SYSTEM.md](docs/DESIGN-SYSTEM.md)); the final typeface and scale still need sign-off. Text follows browser zoom and a text scale preference.

## 6. Surfaces, shape, and depth

- Modestly rounded corners.
- Thin borders and subtle depth.
- Compact browser controls.
- More breathing room around project materials and task summaries.
- Consistent alignment and predictable control placement.

Avoid simulated fabric backgrounds behind reading or browsing content. A very faint weave may appear on the welcome screen, empty states, or brand packaging.

Browser-owned controls must be visually distinct from website content, especially credential dialogs, permissions, site blocks, and approval prompts. A website must not visually appear to own the browser's trusted controls.

Radius, spacing, border, and elevation scales are implemented as tokens in [docs/DESIGN-SYSTEM.md](docs/DESIGN-SYSTEM.md), pending sign-off.

## 7. Application layout

### 7.1 Main arrangement

1. A narrow workspace rail at the far left.
2. A sidebar for the current workspace's tabs and materials.
3. The central browsing area.
4. An agent chat panel that opens on the right.

The central page should retain visual priority during ordinary browsing. Side panels should collapse when not needed. The interface must remain usable without an active agent.

### 7.2 Workspace sidebar

Provide familiar entry points for the workspace sections (Overview, Materials, Context, Tasks, Conversations, Artifacts, Activity, Workflows, and Mailbox) and the workspace's tabs. Sections appear as a grid of icons; each keeps its name as the accessible label and hover tooltip, so the icons never stand alone for assistive technology. Keep active selection clear without filling every row with accent color.

### 7.3 Workspace overview

The overview should reveal recent activity, saved references, active tasks, and anything waiting on the human. It should feel like returning to an organized project desk.

Show useful summaries with direct links to underlying tasks and evidence. Avoid turning the opening screen into a dense administrative dashboard.

### 7.4 Split views and command palette

Use thin, clear dividers for split views and an unmistakable focus indicator for the active pane. The command palette should share the application's typography, warm surfaces, and selection treatment.

## 8. Logo direction

### 8.1 Core concept

Explore **two interlocking bands forming a subtle W**. The mark should express connection and structure while remaining recognizable as a small browser icon.

It must work in one color before adding accent colors, shading, or detail. Avoid relying on texture to explain the shape.

### 8.2 Concepts to explore

The following are alternative treatments of the proposed woven-W idea, not completed logos:

| Concept | Description | Intended character |
| --- | --- | --- |
| **Interlocking bands** | Two broad bands cross to suggest a W, with one clear over-under relationship | Direct, approachable, recognizable |
| **Geometric weave** | A more angular W built from precise intersecting strokes and open negative space | Structured, capable, technical |
| **Soft ribbon** | A gentler version of the interlocking mark with softened turns and restrained dimensional cues | Warm, creative, studio-like |

The preferred general direction remains an interlocking W. Geometry, crossing treatment, proportions, and final lockup remain open.

### 8.3 Required explorations

- Symbol alone and symbol with the **Weft** wordmark.
- Plum on ivory.
- Charcoal on ivory.
- Single-color black and reversed white.
- Dark-background treatment.
- Small favicon and application-icon views.

Check small-size readability, distinguishable negative space, balanced weight, and whether the symbol remains understandable without decorative effects. Very small icons may need a simplified optical variant.

## 9. Woven details and iconography

A small crossing-line motif may recur in:

- The application icon.
- Workspace creation or onboarding.
- Relationships between a task and its saved evidence.
- A brief human-agent handoff transition.

Use conventional, consistent icons for common browser actions. The woven identity should complement recognizable controls rather than make every icon custom or metaphorical.

## 10. Agent presence and state

Agents should feel visibly present and calm. Activity belongs near the tab, task, or panel it affects.

| State | Proposed treatment |
| --- | --- |
| Working | Small animated marker beside the assigned tab or task |
| Waiting for you | Persistent badge with a plain-language reason |
| Paused | Static pause marker |
| Completed | Checkmark linked to results and evidence |
| Blocked | Clear explanation and available next action |

Use names, icons, and labels alongside color. Distinguish an agent's identity from its current status.

### 10.1 Control and handoff

A brief border transition around the affected tab or pane can signal human takeover or return to an agent. The current controller must also be stated persistently; the animation alone cannot communicate ownership.

### 10.2 Chat panel

Use the same warm surfaces and typography as the rest of the browser. Keep model selection, current task, actions, and blockers understandable. Tool results should be expandable so routine detail does not dominate the conversation.

## 11. Motion

Motion should explain state changes and activity without distracting from the page.

- Keep working indicators small and local.
- Use short transitions for selection, panel changes, and handoff.
- Reserve woven movement for occasional identity moments.
- Avoid continuous background fabric animation or decorative movement behind content.
- Provide reduced-motion alternatives with persistent static state labels.

Durations and easing curves are implemented as motion tokens (see [docs/DESIGN-SYSTEM.md](docs/DESIGN-SYSTEM.md)) and still need sign-off. Motion must never be the only evidence that an action occurred.

## 12. Artifact collection

Artifacts should resemble **reference cards in a project collection**.

Each card should show a useful thumbnail, title, source, capture date, and optional short note. Provide a readable list alternative when thumbnails add little value.

Opening a reference must clearly distinguish **Saved capture** from **Live page**. Version information and capture limitations should be easy to find.

This collection is a potential signature screen for Weft: accumulated project knowledge that humans can browse visually and agents can reference precisely.

Screenshots should remain visually faithful to the captured page. Do not tint them for branding or imply that historical captures are current live pages.

## 13. Privacy and permission surfaces

Use quiet indicators for policies already being enforced. Details and exceptions should be available in browser-owned panels.

| Surface | Visual goal |
| --- | --- |
| Site storage panel | Explain allowed/blocked behavior with clear choices |
| Don't trust this site stop page | Show the rule, reason, and scoped override options |
| Credential operation | Clearly identify protected browser control and the authorized destination |
| Agent approval | State who wants to do what, where, and within which scope |
| Download panel | Show source and status without implying every downloaded file is safe |

Personal preference blocks should look like user choices, not automatically receive the same severe treatment as confirmed security threats. Reserve strong warning treatment for the appropriate risk and always explain the reason in text.

## 14. Accessibility and usability

- Validate contrast for actual light and dark combinations.
- Provide visible keyboard focus and complete keyboard navigation.
- Do not rely solely on color for identity, ownership, state, or warnings.
- Support text scaling and reduced motion.
- Use accessible labels and screen-reader announcements for meaningful changes.
- Preserve legibility in compact controls and metadata.
- Give controls comfortable interaction targets even when the visual treatment is compact.

## 15. Preferred direction and open decisions

### Preferred starting direction

**Warm ivory, plum, charcoal, fine borders, readable sans serif typography, and an interlocking W mark.**

Keep the main interface restrained and let workspace materials, saved references, and agent activity supply most of its visual richness.

### Still to decide

- Final logo and wordmark.
- Final typeface and type scale.
- Exact dark palette.
- Status, warning, error, and focus colors.
- Spacing, radius, elevation, and border scales.
- Whether project spaces are called Workspaces, Desks, or Hubs.
- Final sidebar density and panel behavior at different window sizes.
- Motion timing and small-icon variants.

These decisions should preserve Weft's central feeling: a calm, capable creative studio where a project stays ready for its next session.
