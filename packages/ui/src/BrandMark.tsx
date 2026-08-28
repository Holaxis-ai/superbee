/**
 * The Superbee mark, inlined (no external image request — the strict CSP and the offline-first
 * posture both rule that out). Two paths against the Holaxis chevron's nine: an amber hexagon
 * with a knocked-out centre, and a chevron inside it.
 *
 * Geometry is COPIED, never redrawn. It is generated from locked parameters in the brand kit
 * (`scripts/superbee-mark.js`, geometry locked in plans/superbee-brand-buildout T4: regular
 * pointy-top hexagon, chevron arms at 45 degrees with horizontal caps) and the committed asset
 * set is hash-checked there. Any change belongs upstream in the kit, not here — the mark is a
 * trademark asset (tasks/superbee-trademark-protection).
 *
 * The chevron is the only theme-dependent part: `brands.superbee.mark` specifies
 * `chevronOnDark` #3CAEF9 and `chevronOnLight` #1B6A9E, so it is driven by a token the theme
 * blocks in styles.css set rather than duplicating a media query here. The hexagon is the same
 * amber on both grounds.
 *
 * `aria-hidden` — the header's own text already names the app.
 */
export function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <svg
      className="app-mark"
      width={size}
      height={size}
      viewBox="0 0 512 512"
      fill="none"
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        className="app-mark-hex"
        fillRule="evenodd"
        d="M 256.00 19.99 L 51.61 138.00 L 51.61 374.00 L 256.00 492.01 L 460.39 374.00 L 460.39 138.00 Z M 256.00 63.32 L 89.14 159.66 L 89.14 352.34 L 256.00 448.68 L 422.86 352.34 L 422.86 159.66 Z"
      />
      <path
        className="app-mark-chevron"
        d="M 238.93 143.42 L 351.50 256.00 L 238.93 368.58 L 160.50 368.58 L 273.07 256.00 L 160.50 143.42 Z"
      />
    </svg>
  );
}
