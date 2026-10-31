# FeedBouncer web design system

The web app is dark-only and shares its visual language with the public FeedBouncer website. Every value lives once, in the `:root` block of `src/app/globals.css`, as a `--fb-*` custom property. `@theme inline` in the same file maps those properties to Tailwind utilities and to shadcn's semantic variables. Components use utilities and never write raw colours, pixel font sizes or durations.

Website sources cite `feedbouncer-website/styles.css` as `styles.css:<line>`.

## Copied from feedbouncer-website

### Colour

| token               | value       | website source                        | Tailwind utility                                       |
| ------------------- | ----------- | ------------------------------------- | ------------------------------------------------------ |
| `--fb-bg`           | `#0b0e14`   | styles.css:2                          | `bg-background`                                        |
| `--fb-bg-elevated`  | `#121622`   | styles.css:3                          | `bg-elevated`, `bg-secondary`, `bg-muted`, `bg-accent` |
| `--fb-bg-card`      | `#161b29`   | styles.css:4                          | `bg-card`, `bg-popover`                                |
| `--fb-border`       | `#242b3d`   | styles.css:5                          | `border-border`                                        |
| `--fb-text`         | `#e8eaf0`   | styles.css:6                          | `text-foreground`                                      |
| `--fb-text-dim`     | `#9aa3b8`   | styles.css:7                          | `text-dim`, `text-muted-foreground`                    |
| `--fb-text-faint`   | `#7f889d`   | styles.css:8                          | `text-faint`                                           |
| `--fb-accent`       | `#e06952`   | styles.css:9                          | `bg-coral`, `text-coral`, `bg-primary`, `ring-ring`    |
| `--fb-accent-dim`   | `#e0695233` | styles.css:10                         | `bg-coral-dim`                                         |
| `--fb-accent-hover` | `#ea7e67`   | styles.css:226 (`.btn-primary:hover`) | `bg-coral-hover`                                       |
| `--fb-good`         | `#34b483`   | styles.css:12                         | `text-good`, `bg-good/15`                              |
| `--fb-shadow-color` | `10, 6, 5`  | styles.css:17                         | used inside the shadow tokens                          |

### Type

| token                   | value                                                                                            | website source                                | Tailwind utility          |
| ----------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------- | ------------------------- |
| `--fb-font-display`     | `'Space Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`                     | styles.css:15                                 | `font-display`            |
| `--fb-font-body`        | `'Manrope', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif` | styles.css:16                                 | `font-sans`               |
| `--fb-font-mono`        | `ui-monospace, SFMono-Regular, Menlo, monospace`                                                 | styles.css:608                                | `font-mono`               |
| `--fb-text-micro`       | `11px`                                                                                           | styles.css:339                                | `text-micro`              |
| `--fb-text-caption`     | `11.5px`                                                                                         | styles.css:599 (table header)                 | `text-caption`            |
| `--fb-text-small`       | `13px`                                                                                           | styles.css:281                                | `text-small`              |
| `--fb-text-label`       | `13.5px`                                                                                         | styles.css:664                                | `text-label`              |
| `--fb-text-ui`          | `14.5px`                                                                                         | styles.css:175 (buttons, nav, tables, inputs) | `text-ui`                 |
| `--fb-text-body`        | `16px`                                                                                           | styles.css:566                                | `text-body`               |
| `--fb-text-card-title`  | `16.5px`                                                                                         | styles.css:397, 510                           | `text-card-title`         |
| `--fb-text-lede`        | `18px`                                                                                           | styles.css:310                                | `text-lede`               |
| `--fb-text-brand`       | `19px`                                                                                           | styles.css:154                                | `text-brand`              |
| `--fb-text-section`     | `22px`                                                                                           | styles.css:769 (`.legal h2`)                  | `text-section`            |
| `--fb-text-page`        | `clamp(26px, 4vw, 36px)`                                                                         | styles.css:390 (`h2`)                         | `text-page`               |
| `--fb-text-hero`        | `clamp(36px, 6vw, 62px)`                                                                         | styles.css:295 (`h1`)                         | `text-hero`               |
| `--fb-leading-body`     | `1.6`                                                                                            | styles.css:63                                 | `text-body` (line height) |
| `--fb-leading-hero`     | `1.05`                                                                                           | styles.css:296                                | `text-hero` (line height) |
| `--fb-tracking-hero`    | `-0.025em`                                                                                       | styles.css:298                                | `tracking-hero`           |
| `--fb-tracking-page`    | `-0.01em`                                                                                        | styles.css:392                                | `tracking-page`           |
| `--fb-tracking-brand`   | `-0.02em`                                                                                        | styles.css:155                                | `tracking-brand`          |
| `--fb-tracking-caption` | `0.04em`                                                                                         | styles.css:598                                | `tracking-caption`        |
| `--fb-tracking-kicker`  | `0.08em`                                                                                         | styles.css:337                                | `tracking-kicker`         |

Weights match the website's font request (`index.html:12`): display 500, 600, 700 and body 400, 500, 600, 700.

### Spacing

Tailwind's default `--spacing: 0.25rem` stays. The named layout tokens are:

| token            | value    | website source | Tailwind utility       |
| ---------------- | -------- | -------------- | ---------------------- |
| `--fb-gutter`    | `24px`   | styles.css:96  | `px-(--fb-gutter)`     |
| `--fb-header-h`  | `68px`   | styles.css:147 | `h-(--fb-header-h)`    |
| `--fb-section-y` | `72px`   | styles.css:365 | `py-(--fb-section-y)`  |
| `--fb-card-pad`  | `26px`   | styles.css:470 | `p-(--fb-card-pad)`    |
| `--fb-form-gap`  | `16px`   | styles.css:653 | `gap-(--fb-form-gap)`  |
| `--fb-field-gap` | `6px`    | styles.css:659 | `gap-(--fb-field-gap)` |
| `--fb-maxw`      | `1120px` | styles.css:14  | `max-w-content`        |

### Radius

| token                 | value   | website source                                   | Tailwind utility              |
| --------------------- | ------- | ------------------------------------------------ | ----------------------------- |
| `--fb-radius-chip`    | `6px`   | styles.css:277, 348                              | `rounded-sm`                  |
| `--fb-radius-control` | `8px`   | styles.css:123, 675 (inputs, callout, skip link) | `rounded-md`                  |
| `--fb-radius-icon`    | `10px`  | styles.css:498                                   | `rounded-(--fb-radius-icon)`  |
| `--radius`            | `12px`  | styles.css:13 (card)                             | `rounded-lg`                  |
| `--fb-radius-panel`   | `20px`  | styles.css:626                                   | `rounded-xl`                  |
| `--fb-radius-pill`    | `999px` | styles.css:204 (buttons)                         | `rounded-full`                |
| `--fb-radius-focus`   | `4px`   | styles.css:110 (focus outline)                   | `rounded-(--fb-radius-focus)` |

These override shadcn's calc-based radius scale with the website's values.

### Elevation

| token                 | value                                                 | website source | Tailwind utility |
| --------------------- | ----------------------------------------------------- | -------------- | ---------------- |
| `--fb-shadow-raised`  | `0 18px 40px -22px rgba(var(--fb-shadow-color), 0.7)` | styles.css:487 | `shadow-raised`  |
| `--fb-shadow-panel`   | `0 30px 60px -30px rgba(var(--fb-shadow-color), 0.6)` | styles.css:629 | `shadow-panel`   |
| `--fb-shadow-overlay` | `0 10px 40px rgba(var(--fb-shadow-color), 0.6)`       | styles.css:868 | `shadow-overlay` |
| `--fb-shadow-float`   | `0 4px 16px rgba(var(--fb-shadow-color), 0.5)`        | styles.css:841 | `shadow-float`   |

### Motion

| token                | value                      | website source | Tailwind utility                |
| -------------------- | -------------------------- | -------------- | ------------------------------- |
| `--fb-ease-out`      | `cubic-bezier(.16,1,.3,1)` | styles.css:49  | `ease-fb`                       |
| `--fb-dur-press`     | `150ms`                    | styles.css:209 | `duration-(--fb-dur-press)`     |
| `--fb-dur-hover`     | `200ms`                    | styles.css:124 | `duration-(--fb-dur-hover)`     |
| `--fb-dur-underline` | `250ms`                    | styles.css:187 | `duration-(--fb-dur-underline)` |
| `--fb-dur-glow`      | `300ms`                    | styles.css:480 | `duration-(--fb-dur-glow)`      |

Rules: button hover is `translateY(-2px)` and active is `scale(.97)` (styles.css:213, 217). Every transform transition is written with `motion-safe:`. The reduced-motion block is copied from styles.css:28-38.

## App-only tokens

The website has no equivalent for these.

| token                  | value     | website source                                                                                                | Tailwind utility                |
| ---------------------- | --------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `--fb-input`           | `#5f6880` | app-only: control borders need at least 3:1 against every surface (WCAG 1.4.11); `--fb-border` is about 1.3:1 | `border-input`                  |
| `--fb-danger`          | `#f2786a` | app-only: errors and destructive actions; the website has no error state                                      | `text-danger`, `bg-destructive` |
| `--fb-accent-strong`   | `#f08a75` | app-only: small coral text on the coral tint; plain coral there is about 3.96:1 on a card                     | `text-coral-strong`             |
| `--fb-leading-heading` | `1.2`     | app-only: the website leaves headings at the inherited 1.6, which is too loose for multi-line app headings    | `leading-heading`               |
| `--fb-form-maxw`       | `440px`   | app-only: the website has no standalone forms                                                                 | `max-w-form`                    |

## Accessibility deviations

| token              | value     | website source                                                                                                                                                                | Tailwind utility                           |
| ------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `--fb-accent-text` | `#1a0d09` | deviates from `--accent-text: #fdf1ee` (styles.css:11), which is 3.01:1 on coral; `#1a0d09` is what `.btn-primary`, `.skip-link` and `.a11y-toggle` use (styles.css:119, 222) | `text-on-coral`, `text-primary-foreground` |

`--fb-accent-strong` (above) is the second deviation. Plain `--fb-accent` passes on all three solid surfaces and stays the default for links.

## Contrast results

Computed by `src/app/tokens.test.ts`. Columns are the surfaces `--fb-bg`, `--fb-bg-elevated` and `--fb-bg-card`.

| foreground on background                                     | bg    | elevated | card  | requirement |
| ------------------------------------------------------------ | ----- | -------- | ----- | ----------- |
| `--fb-text`                                                  | 16.06 | 15.00    | 14.28 | 4.5         |
| `--fb-text-dim`                                              | 7.64  | 7.14     | 6.79  | 4.5         |
| `--fb-text-faint`                                            | 5.44  | 5.08     | 4.83  | 4.5         |
| `--fb-accent`                                                | 5.81  | 5.42     | 5.16  | 4.5         |
| `--fb-good`                                                  | 7.36  | 6.88     | 6.54  | 4.5         |
| `--fb-danger`                                                | 7.06  | 6.59     | 6.27  | 4.5         |
| `--fb-input` (border)                                        | 3.48  | 3.25     | 3.09  | 3           |
| `--fb-accent` (focus ring)                                   | 5.81  | 5.42     | 5.16  | 3           |
| `--fb-accent-strong` on `--fb-accent-dim`                    | 6.21  | 5.68     | 5.39  | 4.5         |
| `--fb-accent` on `--fb-accent-dim` (not used for small text) | 4.56  | 4.17     | 3.96  | 4.5         |
| `--fb-good` on good at 15%                                   | 5.97  | 5.44     | 5.14  | 4.5         |
| `--fb-danger` on danger at 12%                               | 6.08  | 5.58     | 5.30  | 4.5         |

| pair                                          | ratio | requirement |
| --------------------------------------------- | ----- | ----------- |
| `--fb-accent-text` on `--fb-accent`           | 5.71  | 4.5         |
| `--fb-accent-text` on `--fb-accent-hover`     | 6.95  | 4.5         |
| website `#fdf1ee` on `--fb-accent` (rejected) | 3.01  | 4.5         |

## Heading mapping

Every size comes from the website's scale.

| element | token                  | utility                                                                            |
| ------- | ---------------------- | ---------------------------------------------------------------------------------- |
| `h1`    | `--fb-text-page`       | `text-page` (the website's `hero` size is reserved for the public `/scan` landing) |
| `h2`    | `--fb-text-section`    | `text-section`                                                                     |
| `h3`    | `--fb-text-card-title` | `text-card-title`                                                                  |

Headings use `--fb-leading-heading` (1.2) and the display family.

## How to style a new screen

1. Use the shell (header, page container and footer) rather than building your own layout chrome.
2. Use the primitives in `src/components/ui` (button, input, card and the rest) before writing new markup.
3. Never write raw values. Colours, font sizes, radii, shadows and durations come from the utilities above. If a value is missing, add it to `:root` and this document together.
4. Use logical utilities (`ps-`, `pe-`, `ms-`, `me-`, `text-start`, `text-end`, `start-`, `end-`), never the physical left and right ones, so right-to-left comment content lays out correctly.

## Keeping in sync

1. Re-diff `feedbouncer-website/styles.css:1-18` against the "Copied from feedbouncer-website" tables.
2. Update the `:root` block in `src/app/globals.css` and this document in the same change. `src/app/design-doc.test.ts` fails if a token or its value is missing here.
3. Re-run the tests: `src/app/tokens.test.ts` re-proves every contrast pair above.
4. Do not add a light theme or a `.dark` override block; the website ships none.
